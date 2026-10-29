import { handleInstantlyWebhook } from '@/lib/instantly-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handleInstantlyWebhook(request)
}
