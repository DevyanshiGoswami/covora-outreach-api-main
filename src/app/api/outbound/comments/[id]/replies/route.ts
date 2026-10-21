import { createOutboundCommentsHandlers } from '@/lib/outbound-comments-api'

const handlers = createOutboundCommentsHandlers()
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.reply(request, (await context.params).id)
}
