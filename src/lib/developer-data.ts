import 'server-only'
import { z } from 'zod'
import { ApiError, json, readJson, type OutboundApiConfig } from './outbound-http'
import { developmentRuntime, resolveDeveloperSession } from './developer-session'

const views = new Set(['client_outreach_workspaces','client_outreach_campaigns','client_outreach_messages','client_outreach_network_campaigns',
 'client_outreach_campaign_daily','client_outreach_campaign_steps','client_outreach_leads','client_outreach_linkedin_daily'])
/** Deliberately not a general PostgREST proxy: no embeds, computed fields,
 * alternate schemas, RPC discovery or arbitrary write methods. */
export function scopedDataQuery(url: URL, clientId: string) {
 const query = new URLSearchParams(url.search)
 const resources = query.getAll('resource'), resource = resources[0]
 if (resources.length !== 1 || !views.has(resource) || url.search.length > 8192) throw new ApiError(403)
 query.delete('resource')
 const seen = new Set<string>()
 for (const [key,value] of query) {
   // Flat filters may repeat: date windows use both day.gte and day.lte.
   // PostgREST combines these with AND. Keep controls and tenant scope unique.
   if (!/^[a-z_]+$/.test(key) || (seen.has(key) && ['select','order','limit','offset','client_id'].includes(key))) throw new ApiError(403)
   seen.add(key)
   if (key === 'select') { if (!/^[a-z_]+(?:,[a-z_]+)*$/.test(value)) throw new ApiError(403) }
   else if (key === 'order') { if (!/^[a-z_]+(?:\.(?:asc|desc|nullsfirst|nullslast))*(?:,[a-z_]+(?:\.(?:asc|desc|nullsfirst|nullslast))*)*$/.test(value)) throw new ApiError(403) }
   else if (key === 'limit' || key === 'offset') { if (!/^\d{1,6}$/.test(value) || Number(value) > (key === 'limit' ? 1000 : 100000)) throw new ApiError(403) }
   else if (key === 'client_id') { if (value !== `eq.${clientId}`) throw new ApiError(403) }
   else if (!/^(eq|neq|gte|lte|gt|lt|is|in)\./.test(value) || ['or','and','not'].includes(key)) throw new ApiError(403)
 }
 if (!query.has('select')) throw new ApiError(403)
 query.set('client_id', `eq.${clientId}`)
 if (!query.has('limit')) query.set('limit','1000')
 return { resource, query }
}
export function createDeveloperDataHandler(config?: OutboundApiConfig) {
 return async (request: Request): Promise<Response> => {
  try {
   const token = request.headers.get('authorization')?.match(/^Bearer ([^\s,]+)$/i)?.[1] ?? ''
   const session = await resolveDeveloperSession(token, config)
   const runtime = developmentRuntime(config), url = new URL(request.url)
   const headers = new Headers({ apikey: runtime.anonKey, Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' })
   let target: string, body: string | undefined
   if (request.method === 'GET' || request.method === 'HEAD') {
     const scoped = scopedDataQuery(url, session.clientId)
     target = `${runtime.url}/rest/v1/${scoped.resource}?${scoped.query}`
     if (request.headers.get('prefer')?.split(',').includes('count=exact')) headers.set('Prefer','count=exact')
     if (request.headers.get('accept') === 'application/vnd.pgrst.object+json') headers.set('Accept','application/vnd.pgrst.object+json')
   } else if (request.method === 'POST' && url.searchParams.size === 1 && url.searchParams.get('resource') === 'mark_outreach_messages_read') {
     const input = z.strictObject({ ids: z.array(z.uuid()).min(1).max(500) }).safeParse(await readJson(request,32768))
     if (!input.success) throw new ApiError(400)
     const ids = [...new Set(input.data.ids)]
     // Keep each ownership lookup below gateway URL limits, then perform the
     // original atomic mark-read RPC only after every batch is authorized.
     const batches: string[][] = []
     for (let i=0; i<ids.length; i+=100) batches.push(ids.slice(i,i+100))
     const found = await Promise.all(batches.map(batch => runtime.admin.from('outreach_messages').select('id').eq('client_id',session.clientId).in('id',batch)))
     if (found.some(result => result.error) || found.flatMap(result => result.data ?? []).length !== ids.length) throw new ApiError(403)
     target = `${runtime.url}/rest/v1/rpc/mark_outreach_messages_read`
     body = JSON.stringify({ ids: ids })
   } else throw new ApiError(403)
   const response = await runtime.transport(target, { method: request.method, headers, body, signal: request.signal })
   if (!response.ok) { await response.body?.cancel(); return json({ message: 'Workspace query unavailable.' }, [400,401,403,406].includes(response.status) ? response.status : 502) }
   const outgoing = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Authorization' })
   const count = response.headers.get('content-range'); if (count && /^[\d*]+(?:-\d+)?\/[\d*]+$/.test(count)) outgoing.set('Content-Range',count)
   return new Response(response.body, { status: response.status, headers: outgoing })
  } catch (error) { return json({ message: 'Workspace query unavailable.' }, error instanceof ApiError ? error.status : 500) }
 }
}
