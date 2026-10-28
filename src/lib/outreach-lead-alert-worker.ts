import 'server-only'
import { z } from 'zod'
import { createSupabaseAdminClient } from './supabase/admin'
import type { CronContext } from './cron-worker'

export const leadAlertDispatchSchema = z.object({
  id: z.uuid(), claimToken: z.uuid(), clientId: z.uuid(), userId: z.uuid(),
  recipientEmail: z.email().max(254), leadCount: z.number().int().min(1).max(10_000),
  expiresAt: z.iso.datetime({ offset: true }),
})
export type LeadAlertDispatch = z.infer<typeof leadAlertDispatchSchema>
type Policy = { clientId: string; userId: string }
type Outcome = { status: 'sent' | 'failed' | 'unknown'; errorCode?: string }
/** A configured transport must settle within eight seconds and never retry sends. */
export type LeadAlertTransport = { configured: boolean; send: (delivery: LeadAlertDispatch) => Promise<Outcome> }
export type LeadAlertWorkerDependencies = {
  enabled: boolean; configured: boolean; timeLeft: () => number; now: () => number
  listPolicies: (offset: number, limit: number) => Promise<Policy[]>
  claim: (policy: Policy) => Promise<LeadAlertDispatch | null>
  dispatch: (claim: LeadAlertDispatch) => Promise<LeadAlertDispatch | null>
  finish: (claim: LeadAlertDispatch, status: Outcome['status'], errorCode?: string) => Promise<boolean>
  send: LeadAlertTransport['send']
}
// Reserve only the next attempted recipient. Reserving a whole page before
// slow work would keep rotating unprocessed recipients back to the same tail.
const PAGE_SIZE = 1
// Each stage has an eight-second timeout. Admit work only when every
// remaining stage, including recording the result, fits within the deadline.
const CLAIM_BUDGET_MS = 35_000
const DISPATCH_BUDGET_MS = 27_000
const SEND_BUDGET_MS = 18_000
const safeCodes = new Set(['invalid_claim', 'invalid_dispatch', 'worker_deadline', 'transport_unknown', 'delivery_rejected', 'rate_limited', 'delivery_unconfigured'])

/** Discovery and sending are bounded; SQL owns deduplication and current authority. */
export async function drainLeadAlerts(deps: LeadAlertWorkerDependencies) {
  const result = { disabled: !deps.enabled, checked: 0, sent: 0, skipped: 0, deferred: 0, unknown: 0, failed: 0 }
  if (!deps.enabled) return result
  if (!deps.configured) { result.failed++; return result }
  for (let offset = 0; offset < 2000; offset += PAGE_SIZE) {
    if (deps.timeLeft() < CLAIM_BUDGET_MS) { result.deferred++; break }
    let policies: Policy[]
    try { policies = await deps.listPolicies(offset, PAGE_SIZE) }
    catch { result.failed++; break }
    for (const policy of policies) {
      if (deps.timeLeft() < CLAIM_BUDGET_MS) { result.deferred++; return result }
      result.checked++
      try {
        const claim = await deps.claim(policy)
        if (!claim) { result.skipped++; continue }
        if (!leadAlertDispatchSchema.safeParse(claim).success || claim.clientId !== policy.clientId || claim.userId !== policy.userId) {
          result.failed++; continue
        }
        if (deps.timeLeft() < DISPATCH_BUDGET_MS || Date.parse(claim.expiresAt) <= deps.now()) {
          // Nothing was dispatched. Let the preparation lease expire so a
          // later tick can safely reclaim it without operator intervention.
          result.deferred++
          if (deps.timeLeft() < DISPATCH_BUDGET_MS) return result
          continue
        }
        const dispatched = await deps.dispatch(claim)
        if (!dispatched) { result.skipped++; continue }
        if (!leadAlertDispatchSchema.safeParse(dispatched).success || dispatched.id !== claim.id || dispatched.claimToken !== claim.claimToken
          || dispatched.clientId !== claim.clientId || dispatched.userId !== claim.userId || dispatched.recipientEmail !== claim.recipientEmail
          || Date.parse(dispatched.expiresAt) <= deps.now() || deps.timeLeft() < SEND_BUDGET_MS) {
          await deps.finish(claim, 'unknown', 'invalid_dispatch')
          result.failed++; result.unknown++; continue
        }
        let outcome: Outcome
        try { outcome = await deps.send(dispatched) }
        catch { outcome = { status: 'unknown', errorCode: 'transport_unknown' } }
        if (!['sent', 'failed', 'unknown'].includes(outcome.status)) outcome = { status: 'unknown', errorCode: 'transport_unknown' }
        const code = outcome.errorCode && safeCodes.has(outcome.errorCode) ? outcome.errorCode : undefined
        let recorded = false
        try { recorded = await deps.finish(dispatched, outcome.status, code) } catch { /* Lease expiry keeps uncertain dispatches quarantined. */ }
        if (!recorded) { result.failed++; result.unknown++; continue }
        if (outcome.status === 'sent') result.sent++
        else { result.failed++; if (outcome.status === 'unknown') result.unknown++ }
      } catch { result.failed++ }
    }
    if (policies.length < PAGE_SIZE) return result
  }
  return result
}

function parseDispatch(value: unknown) { return value === null ? null : leadAlertDispatchSchema.parse(value) }

/** Callers supply the transport; the cron route wires the separately gated Resend adapter. */
export async function runOutreachLeadAlerts(context: CronContext, transport?: LeadAlertTransport) {
  const enabled = process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS === 'true'
  if (!enabled || !transport?.configured) return { disabled: !enabled, checked: 0, sent: 0, skipped: 0, deferred: 0, unknown: 0, failed: enabled ? 1 : 0 }
  const admin = createSupabaseAdminClient()
  return drainLeadAlerts({
    enabled, configured: transport.configured, timeLeft: context.timeLeft, now: Date.now,
    async listPolicies(_offset, limit) {
      const { data, error } = await admin.rpc('reserve_outreach_lead_alert_policies', { p_limit: limit })
        .abortSignal(AbortSignal.timeout(8000)).retry(false)
      if (error) throw new Error('Lead alert policy query failed')
      return z.array(z.object({ clientId: z.uuid(), userId: z.uuid() })).max(PAGE_SIZE).parse(data)
    },
    async claim(policy) {
      const { data, error } = await admin.rpc('claim_outreach_lead_alert', { p_client_id: policy.clientId, p_user_id: policy.userId }).abortSignal(AbortSignal.timeout(8000)).retry(false)
      if (error) throw new Error('Lead alert claim failed')
      return parseDispatch(data)
    },
    async dispatch(claim) {
      const { data, error } = await admin.rpc('dispatch_outreach_lead_alert', { p_delivery_id: claim.id, p_claim_token: claim.claimToken }).abortSignal(AbortSignal.timeout(8000)).retry(false)
      if (error) throw new Error('Lead alert dispatch failed')
      return parseDispatch(data)
    },
    async finish(claim, status, errorCode) {
      const { data, error } = await admin.rpc('finish_outreach_lead_alert', { p_delivery_id: claim.id, p_claim_token: claim.claimToken, p_status: status, p_error_code: errorCode ?? undefined }).abortSignal(AbortSignal.timeout(8000)).retry(false)
      if (error) throw new Error('Lead alert completion failed')
      return data === true
    },
    send: transport.send,
  })
}
