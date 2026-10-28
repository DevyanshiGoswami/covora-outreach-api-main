import { createOutboundConversationHandlers } from '@/lib/outbound-conversations-api'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createOutboundConversationHandlers().reply(request, (await context.params).id)
}
