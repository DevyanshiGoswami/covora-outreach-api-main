import { createOutboundConversationHandlers } from '@/lib/outbound-conversations-api'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return createOutboundConversationHandlers().detail(request, (await context.params).id)
}
