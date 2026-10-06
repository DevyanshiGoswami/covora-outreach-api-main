export type ReplyProviderContext = {
  channel: 'email' | 'linkedin'; credentialRef: string; remoteWorkspaceId: string
  remoteSenderId: string; senderAddress: string; remoteConversationId: string
  remoteReplyToId: string | null; remoteLatestMessageId: string | null
  remoteCampaignId: string | null; contactAddress: string
  latestMessageFingerprint: string | null; subject: string; bodyText: string
}
export type ReplyProviderOptions = {
  /** Explicit override for simulated adapters; production uses the global gate. */
  repliesEnabled?: boolean
  credentials?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch
  timeoutMs?: number; signal?: AbortSignal
}
export type ScopedReplyOptions = { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }
export type PrepareReason = 'unavailable' | 'changed' | 'identity_mismatch'
export type SendOutcome = { status: 'sent' | 'failed' | 'unknown'; remoteMessageId: string | null }
