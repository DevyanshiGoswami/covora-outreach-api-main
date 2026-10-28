import { createOutboundConversationHandlers } from '@/lib/outbound-conversations-api'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createOutboundConversationHandlers().read(request, (await context.params).id)
}
