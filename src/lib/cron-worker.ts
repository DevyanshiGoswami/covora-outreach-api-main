import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { requireRuntimeDatabase, runtimeConfiguration } from '@/lib/runtime-config'

export type CronContext = { deadline: number; timeLeft: () => number }
export type CronResult = Record<string, unknown> & { failed?: number; http_status?: number }
export type CronWorkerOptions = {
  name: 'outreach-sync' | 'outreach-lead-alerts'
  maxMs?: number
  run: (context: CronContext) => Promise<CronResult>
}
function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  const supplied = request.headers.get('authorization')?.match(/^Bearer[\t ]+([^\s,]+)[\t ]*$/i)?.[1]
  if (!expected || !supplied) return false
  const a = Buffer.from(expected), b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}
function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}
async function heartbeat(name: string, succeeded: boolean, note: string) {
  try {
    const result = await createSupabaseAdminClient().rpc('record_worker_heartbeat', {
      worker_name: name, succeeded, result_note: note.slice(0, 500),
    })
    return !result.error
  } catch { return false }
}
export async function runCronWorker(request: Request, { name, maxMs = 45000, run }: CronWorkerOptions): Promise<Response> {
  if (!authorized(request)) return json({ error: 'Unauthorized' }, 401)
  const configuration = runtimeConfiguration()
  if (!(name === 'outreach-sync' ? configuration.syncEnabled : configuration.alertsEnabled)) {
    return json({ worker: name, ok: true, disabled: true }, 200)
  }
  try { requireRuntimeDatabase(true) } catch { return json({ worker: name, ok: false, error: 'Worker unavailable' }, 503) }
  const started = Date.now(), deadline = started + Math.min(Math.max(1, maxMs), 45000)
  try {
    const result = await run({ deadline, timeLeft: () => Math.max(0, deadline - Date.now()) })
    const { http_status, ...body } = result
    const status = typeof http_status === 'number' && http_status >= 200 && http_status <= 599 ? http_status : (result.failed ?? 0) > 0 ? 500 : 200
    const summary = Object.entries(body).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean')
      .map(([key, value]) => `${key}=${value}`).join(' ') || 'ok'
    const recorded = await heartbeat(name, status < 400, summary)
    return json({ ...body, worker: name, ok: status < 400 && recorded, heartbeatRecorded: recorded, duration_ms: Date.now() - started }, recorded ? status : 503)
  } catch {
    await heartbeat(name, false, 'Worker failed')
    return json({ worker: name, ok: false, error: 'Worker unavailable' }, 500)
  }
}
