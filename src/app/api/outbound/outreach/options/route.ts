import { createOutboundOutreachHandlers } from '@/lib/outbound-outreach-api'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  return createOutboundOutreachHandlers().options(request)
}
