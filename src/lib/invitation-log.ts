import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { requireRuntimeDatabase } from './runtime-config'

/**
 * One step of adding a user (create, open or accept an invitation), recorded so a failed
 * invitation can be explained later. The person only ever sees a generic message; the
 * specific reason lives here. Never contains tokens, passwords or full email addresses.
 */
export type InvitationEvent = {
  step: 'create' | 'inspect' | 'accept'
  outcome: 'ok' | 'failed'
  /** Short snake_case reason, e.g. new_login, existing_login, different_account, replaced_or_revoked. */
  reason: string
  clientId?: string | null
  invitationId?: string | null
  actorUserId?: string | null
  /** Invited email address; stored masked. */
  invitee?: string | null
  detail?: string | null
}
type LogConfig = { url: string; serviceKey?: string; fetch?: typeof fetch }

/** "person@example.com" → "p***@example.com". */
export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const at = value.lastIndexOf('@')
  return at > 0 ? `${value[0]}***${value.slice(at)}`.slice(0, 260) : '***'
}

/** The specific reason the database refused to create an invitation. */
export function createFailureReason(error: { code?: string; message?: string } | null): string {
  if (!error) return 'ok'
  if (error.message === 'Team access denied') return 'not_allowed'
  if (error.message === 'Invalid invitation') return 'invalid_email_or_role'
  if (error.message === 'Use membership management for current access') return 'already_member'
  if (error.code === 'PGRST301' || error.code === 'PGRST302') return 'session_expired'
  return 'database_error'
}

/** Service access for diagnostics only. Null when unavailable: logging never fails a request. */
export function invitationLogClient(config?: LogConfig): SupabaseClient<Database> | null {
  try {
    const runtime = config ?? requireRuntimeDatabase(true)
    if (!runtime.serviceKey) return null
    return createClient<Database>(runtime.url, runtime.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        try { return await (config?.fetch ?? fetch)(input, { ...init, signal: AbortSignal.timeout(2000), cache: 'no-store', redirect: 'error' }) }
        catch { return Response.json({ message: 'Request unavailable' }, { status: 503 }) }
      } },
    })
  } catch { return null }
}

/** The signed-in user behind this request, verified by the auth service. */
export async function invitationActor(request: Request, client: SupabaseClient<Database>): Promise<string | null> {
  try {
    const token = request.headers.get('authorization')?.match(/^Bearer[\t ]+([^\s,]+)[\t ]*$/i)?.[1]
    if (!token) return null
    const { data } = await client.auth.getUser(token)
    return data.user?.id ?? null
  } catch { return null }
}

/** Why the database refused this invitation link for this user (same checks as acceptance). */
export async function diagnoseInvitation(admin: SupabaseClient<Database>, token: string, userId: string | null) {
  try {
    const result = await admin.rpc('diagnose_outreach_invitation', { p_token: token, ...(userId ? { p_user: userId } : {}) })
    const row = Array.isArray(result.data) ? result.data[0] : null
    if (result.error || !row) return { reason: 'diagnosis_unavailable', invitationId: null, clientId: null, invitee: null }
    return { reason: row.reason, invitationId: row.invitation_id, clientId: row.client_id, invitee: row.invitee }
  } catch { return { reason: 'diagnosis_unavailable', invitationId: null, clientId: null, invitee: null } }
}

/** Notes when an already existing login has no workspace access yet, i.e. it may never have finished setup. */
export async function existingLoginDetail(admin: SupabaseClient<Database> | null, invitationId: string): Promise<string | null> {
  if (!admin) return null
  try {
    const invitation = await admin.from('outreach_invitations').select('target_user_id').eq('id', invitationId).single()
    const user = invitation.data?.target_user_id
    if (!user) return null
    const [members, agency] = await Promise.all([
      admin.from('outreach_memberships').select('user_id', { count: 'exact', head: true }).eq('user_id', user).eq('state', 'active'),
      admin.from('outreach_agency_memberships').select('user_id', { count: 'exact', head: true }).eq('user_id', user).eq('state', 'active'),
    ])
    if (members.error || agency.error) return null
    return (members.count ?? 0) + (agency.count ?? 0) === 0
      ? 'This login has no workspace access yet. If it never set a password, it cannot sign in to accept.' : null
  } catch { return null }
}

/** Records why the database refused to open or accept an invitation link. */
export async function logInvitationRefusal(admin: SupabaseClient<Database> | null, step: 'inspect' | 'accept', request: Request,
  client: SupabaseClient<Database>, token: string, error: { code?: string }) {
  const actor = admin ? await invitationActor(request, client) : null
  const why = admin ? await diagnoseInvitation(admin, token, actor) : null
  const known = why && !['ok', 'diagnosis_unavailable'].includes(why.reason)
  await logInvitationEvent(admin, { step, outcome: 'failed', reason: known ? why.reason : error.code === '42501' ? 'refused' : 'database_error',
    clientId: why?.clientId, invitationId: why?.invitationId, invitee: why?.invitee, actorUserId: actor, detail: error.code ? `database code ${error.code}` : null })
}

/** Logs to the server console and, best effort, to outreach_invitation_events. */
export async function logInvitationEvent(admin: SupabaseClient<Database> | null, event: InvitationEvent): Promise<void> {
  const row = {
    step: event.step, outcome: event.outcome, reason: /^[a-z0-9_]{1,60}$/.test(event.reason) ? event.reason : 'unknown',
    client_id: event.clientId ?? null, invitation_id: event.invitationId ?? null, actor_user_id: event.actorUserId ?? null,
    invitee: maskEmail(event.invitee), detail: event.detail ? event.detail.slice(0, 200) : null,
  }
  ;(event.outcome === 'ok' ? console.info : console.warn)('[invitation]', JSON.stringify(row))
  if (!admin) return
  try { await admin.from('outreach_invitation_events').insert(row) } catch { /* Diagnostics are best effort. */ }
}
