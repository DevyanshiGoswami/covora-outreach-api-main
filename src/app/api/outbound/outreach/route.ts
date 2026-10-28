import { createOutboundOutreachHandlers } from '@/lib/outbound-outreach-api'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  return createOutboundOutreachHandlers().GET(request)
}

export async function POST(request: Request) {
  return createOutboundOutreachHandlers().POST(request)
}
