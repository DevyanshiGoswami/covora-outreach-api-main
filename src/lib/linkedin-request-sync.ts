import 'server-only'
import { z } from 'zod'
import { createSupabaseAdminClient } from './supabase/admin'
import { resolveIntegrationCredential } from './integration-credentials'
import type { CronContext } from './cron-worker'
import { discoverLinkedinCampaigns } from './linkedin-campaign-discovery'
import { NetworkReadError } from './network-campaign-provider'

const remoteId = z.number().int().positive().safe()
const metadata = z.object({ id: remoteId, organizationUnitId: remoteId, campaignAccountIds: z.array(remoteId).min(1).max(100) })
const pageSchema = z.object({ totalCount: z.number().int().nonnegative().safe(), items: z.array(z.object({
 linkedInSenderId: remoteId.nullish(), leadConnectionStatus: z.string(), leadMessageStatus: z.string(),
 linkedInUserProfile: z.object({ profileUrl: z.string(), firstName: z.string().nullish(), lastName: z.string().nullish() }),
})).max(100) })
export type RequestScan = { campaign_id: string; client_id: string; remote_campaign_id: string; workspace_id: string; workspace_version: number;
 remote_workspace_id: string; credential_ref: string; page_offset: number; started_at: string; failures: number;
 sender_ids: string[]; sender_versions: number[]; remote_sender_ids: string[] }
export type RequestObservation = { senderId: string; recipient: string; name: string; status: 'sent'|'connected'|'replied' }
export function canonicalLinkedinProfile(value: string): string | null {
 try {
  const u = new URL(value)
  if (u.protocol !== 'https:' || !['www.linkedin.com','linkedin.com'].includes(u.hostname) || u.port || u.username || u.password || !/^\/in\/[a-z0-9_-]{1,200}\/?$/i.test(u.pathname)) return null
  return `https://www.linkedin.com${u.pathname.replace(/\/$/,'').toLowerCase()}`
 } catch { return null }
}
export async function readLinkedinRequestPage(binding: RequestScan, key: string, options: {fetch?: typeof fetch; signal?: AbortSignal} = {}) {
 if (![binding.remote_campaign_id,binding.remote_workspace_id,...binding.remote_sender_ids].every(v=>/^[1-9]\d*$/.test(v)&&Number.isSafeInteger(Number(v)))
  || binding.sender_ids.length<1 || binding.sender_ids.length>100 || binding.sender_ids.length!==binding.remote_sender_ids.length || new Set(binding.remote_sender_ids).size!==binding.remote_sender_ids.length) throw new NetworkReadError()
 const signal = options.signal ?? AbortSignal.timeout(6500)
 async function read(path: string, body?: unknown) {
  const response = await (options.fetch ?? fetch)(`https://api.heyreach.io/api/public${path}`,{method:body?'POST':'GET',headers:{'X-API-KEY':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal,cache:'no-store',redirect:'error'})
  if (!response.ok) {
   const retry=Number(response.headers.get('Retry-After'))*1000
   throw new NetworkReadError(Number.isFinite(retry)?Math.max(0,Math.min(retry,86400000)):0)
  }
  return response.json()
 }
 const campaign = metadata.parse(await read(`/campaign/GetById?campaignId=${binding.remote_campaign_id}`))
 if (String(campaign.id)!==binding.remote_campaign_id || String(campaign.organizationUnitId)!==binding.remote_workspace_id
  || campaign.campaignAccountIds.some(id=>!binding.remote_sender_ids.includes(String(id)))) throw new NetworkReadError()
 const page = pageSchema.parse(await read('/campaign/GetLeadsFromCampaign',{campaignId:campaign.id,offset:binding.page_offset,limit:100,timeFilter:'Everywhere'}))
 if (!page.items.length && page.totalCount>binding.page_offset) throw new NetworkReadError()
 const rows: RequestObservation[] = []
 for (const item of page.items) {
  // Pre-existing connections and message-only campaigns are not evidence of a
  // request sent by this campaign. Only explicit connection statuses qualify.
  if (!['ConnectionSent','ConnectionAccepted'].includes(item.leadConnectionStatus)) continue
  const index=binding.remote_sender_ids.indexOf(String(item.linkedInSenderId))
  const recipient=canonicalLinkedinProfile(item.linkedInUserProfile.profileUrl)
  if(index<0 || !recipient || !campaign.campaignAccountIds.includes(item.linkedInSenderId!)) throw new NetworkReadError()
  rows.push({senderId:binding.sender_ids[index],recipient,name:[item.linkedInUserProfile.firstName,item.linkedInUserProfile.lastName].filter(Boolean).join(' ').slice(0,500),
   status:item.leadMessageStatus==='MessageReply'?'replied':item.leadConnectionStatus==='ConnectionAccepted'?'connected':'sent'})
 }
 return {rows,nextOffset:binding.page_offset+page.items.length<page.totalCount?binding.page_offset+page.items.length:null}
}

export async function syncLinkedinRequests(ctx: CronContext) {
 const result={request_pages:0,requests_observed:0,failed:0,deferred:0}
 if(ctx.timeLeft()<10000) return {...result,deferred:1}
 const db=createSupabaseAdminClient()
 const deadline=Math.min(ctx.deadline-3000,Date.now()+9000)
 const signal=()=>AbortSignal.timeout(Math.max(1,deadline-Date.now()))
 try { await discoverLinkedinCampaigns(signal()) } catch { result.failed++;console.warn(JSON.stringify({event:'linkedin.discovery.failed'})) }
 if(deadline-Date.now()<3500) return {...result,deferred:1}
 const candidate=await db.rpc('next_outreach_linkedin_scan').abortSignal(signal())
 if(candidate.error) throw new Error('Request tracking unavailable')
 const b=candidate.data?.[0]
 if(!b) return result
 try {
  const key=await resolveIntegrationCredential(b.credential_ref,process.env,db,signal())
  if(!key) throw new NetworkReadError()
  const observation=await readLinkedinRequestPage(b,key,{signal:signal()})
  const saved=await db.rpc('save_outreach_linkedin_scan',{p_campaign:b.campaign_id,p_workspace:b.workspace_id,p_workspace_version:b.workspace_version,
   p_sender_ids:b.sender_ids,p_sender_versions:b.sender_versions,p_offset:b.page_offset,p_started:b.started_at,
   p_next_offset:observation.nextOffset??undefined,p_rows:observation.rows}).abortSignal(signal())
  if(saved.error) throw new Error('Request tracking save unavailable')
  if(saved.data) { result.request_pages++;result.requests_observed+=observation.rows.length }
  else result.deferred++
 } catch(error) {
  result.failed++
  const delay=Math.max(Math.min(3600000,60000*2**Math.min(b.failures,6)),error instanceof NetworkReadError?error.retryAfterMs:0)
  await db.from('outreach_linkedin_scans').update({failures:b.failures+1,due_at:new Date(Date.now()+delay).toISOString()}).eq('campaign_id',b.campaign_id).eq('started_at',b.started_at).eq('page_offset',b.page_offset).abortSignal(AbortSignal.timeout(2000))
 }
 console.info(JSON.stringify({event:'linkedin.requests.sync',...result}))
 return result
}
