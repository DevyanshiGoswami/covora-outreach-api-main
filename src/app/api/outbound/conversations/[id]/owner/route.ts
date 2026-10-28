import { createOutboundConversationHandlers } from '@/lib/outbound-conversations-api'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createOutboundConversationHandlers().owner(request, (await context.params).id)
}
