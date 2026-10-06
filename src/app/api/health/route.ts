import { configurationHealth } from '@/lib/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  const health = configurationHealth()
  return Response.json(health, { status: health.ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
