import 'server-only'
import { repliesEnabled } from './runtime-config'
import { prepareScopedInstantlyReply, sendScopedInstantlyReply } from './instantly'
import { prepareScopedLinkedinReply, sendScopedLinkedinReply } from './heyreach'
import type { ReplyProviderContext, ReplyProviderOptions, PrepareReason, SendOutcome } from './outreach-reply-types'
export type { ReplyProviderContext, ReplyProviderOptions } from './outreach-reply-types'
export type PreparedReply = { context: ReplyProviderContext; preparedAt: number }
const preparedKeys = new WeakMap<PreparedReply, string>()

function credential(context: ReplyProviderContext, options: ReplyProviderOptions): string | undefined {
  const prefix = context.channel === 'email' ? /^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$/ : /^OUTREACH_HEYREACH_[A-Z0-9_]{1,100}$/
  return prefix.test(context.credentialRef) ? (options.credentials ?? process.env)[context.credentialRef]?.trim() || undefined : undefined
}

/** Preparation does reads only. The caller must atomically authorize dispatch afterwards. */
export async function prepareOutreachReply(context: ReplyProviderContext, options: ReplyProviderOptions = {}): Promise<{ ok: true; prepared: PreparedReply } | { ok: false; reason: PrepareReason }> {
  const apiKey = credential(context, options)
  if (!repliesEnabled(options.repliesEnabled) || !apiKey || !context.bodyText.trim() || [...context.bodyText].length > 4000 || context.subject.length > 1000
    || !['email', 'linkedin'].includes(context.channel) || options.signal?.aborted) return { ok: false, reason: 'unavailable' }
  try {
    const reason = await (context.channel === 'email' ? prepareScopedInstantlyReply : prepareScopedLinkedinReply)(context, { ...options, apiKey })
    if (reason) return { ok: false, reason }
    const prepared = Object.freeze({ context: Object.freeze({ ...context }), preparedAt: Date.now() })
    preparedKeys.set(prepared, apiKey)
    return { ok: true, prepared }
  } catch { return { ok: false, reason: 'unavailable' } }
}

/** A preparation is consumed once, with the same key, and never retried after dispatch. */
export async function sendOutreachReply(prepared: PreparedReply, options: ReplyProviderOptions = {}): Promise<SendOutcome> {
  const apiKey = preparedKeys.get(prepared)
  preparedKeys.delete(prepared)
  if (!repliesEnabled(options.repliesEnabled) || !apiKey || apiKey !== credential(prepared.context, options) || Date.now() - prepared.preparedAt > 15000
    || options.signal?.aborted) return { status: 'failed', remoteMessageId: null }
  try {
    return await (prepared.context.channel === 'email' ? sendScopedInstantlyReply : sendScopedLinkedinReply)(prepared.context, { ...options, apiKey })
  } catch { return { status: 'unknown', remoteMessageId: null } }
}
