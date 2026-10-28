import { runCronWorker } from '@/lib/cron-worker'
import { runOutreachLeadAlerts } from '@/lib/outreach-lead-alert-worker'
import { createLeadAlertTransport } from '@/lib/outreach-lead-alert-transport'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: Request) {
  return runCronWorker(request, { name: 'outreach-lead-alerts', maxMs: 45_000,
    run: context => runOutreachLeadAlerts(context, createLeadAlertTransport()) })
}

export const GET = handle
export const POST = handle
