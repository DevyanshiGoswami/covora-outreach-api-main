import { createOutboundCommentsHandlers } from '@/lib/outbound-comments-api'

const handlers = createOutboundCommentsHandlers()
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  return handlers.detail(request, (await context.params).id)
}
export async function PATCH(request: Request, context: Context) {
  return handlers.updateStatus(request, (await context.params).id)
}
