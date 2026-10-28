import { runCronWorker } from '@/lib/cron-worker'
import { syncOutreach } from '@/lib/outreach-sync-worker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: Request) {
  return runCronWorker(request, { name: 'outreach-sync', maxMs: 45_000, run: syncOutreach })
}

export const GET = handle
export const POST = handle
