import 'server-only'
import { linkedinMessageFingerprint, listScopedLinkedinConversations } from './heyreach'
import { neutralText } from './outreach-sync-data'
import type { ScopedReplyOptions } from './outreach-reply-types'

export type LinkedinCampaignAssignment = { id: string; remoteCampaignId: string }
export type ConversationSyncSender = { id: string; remoteSenderId: string; senderAddress: string; senderLabel: string; campaigns: LinkedinCampaignAssignment[] }
export type ConversationSyncInput = {
  senderId: string; campaignId: string; remoteCampaignId: string; remoteConversationId: string; contactName: string; contactAddress: string; subject: string
  messages: Array<{ fingerprint: string; direction: 'sent' | 'received'; bodyText: string; sentAt: string; senderLabel: string }>
}
const safeText = (text: string) => neutralText(text).replace(/heyreach/gi, 'delivery service')

/** One bounded page. The caller persists its cursor only after all idempotent writes succeed. */
export async function syncLinkedinConversationPage(sender: ConversationSyncSender, cursor: string | null, options: ScopedReplyOptions, save: (value: ConversationSyncInput) => Promise<void>): Promise<{ synced: number; nextCursor: string | null }> {
  const page = await listScopedLinkedinConversations(sender.remoteSenderId, sender.senderAddress, sender.campaigns.map(campaign => campaign.remoteCampaignId), cursor, options)
  let synced = 0
  for (const chat of page.items) {
    // A connected personal account is not blanket permission to mirror personal DMs.
    if (chat.groupChat) continue
    const campaign = sender.campaigns.find(assignment => assignment.remoteCampaignId === String(chat.campaignId))
    if (!campaign) throw new Error('Conversation campaign unavailable')
    const contactName = safeText([chat.correspondentProfile.firstName, chat.correspondentProfile.lastName].filter(Boolean).join(' ')) || 'Contact'
    await save({
      senderId: sender.id, campaignId: campaign.id, remoteCampaignId: campaign.remoteCampaignId,
      remoteConversationId: chat.id, contactName, contactAddress: chat.correspondentProfile.profileUrl,
      subject: 'LinkedIn conversation',
      messages: chat.messages.map(message => ({
        fingerprint: linkedinMessageFingerprint(message), direction: message.sender === 'ME' ? 'sent' : 'received',
        bodyText: safeText(message.body), sentAt: new Date(message.createdAt).toISOString(),
        senderLabel: message.sender === 'ME' ? sender.senderLabel : contactName,
      })),
    })
    synced++
  }
  return { synced, nextCursor: page.nextCursor }
}
