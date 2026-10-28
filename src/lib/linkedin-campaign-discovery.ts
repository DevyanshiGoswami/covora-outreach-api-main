import 'server-only'
import {z} from 'zod'
import {createSupabaseAdminClient} from './supabase/admin'
import {resolveIntegrationCredential} from './integration-credentials'
import {neutralText} from './outreach-sync-data'
const remote=z.number().int().positive().safe()
const bindingSchema=z.object({workspaceId:z.uuid(),workspaceVersion:z.number(),remoteWorkspaceId:z.string(),credentialRef:z.string(),offset:z.number().int().nonnegative(),claim:z.uuid(),senders:z.array(z.object({id:z.uuid(),version:z.number(),remoteId:z.string()})).min(1).max(100)})
const campaignsSchema=z.object({totalCount:z.number().int().nonnegative(),items:z.array(z.object({id:remote,organizationUnitId:remote,campaignAccountIds:z.array(remote),name:z.string(),status:z.string()})).max(100)})
export function scopedDiscoveredCampaigns(input:unknown,workspace:string,senders:readonly string[]) {
 const page=campaignsSchema.parse(input)
 return {...page,scoped:page.items.filter(c=>String(c.organizationUnitId)===workspace && c.campaignAccountIds.length>0 && c.campaignAccountIds.every(s=>senders.includes(String(s))))
 .map(c=>({id:String(c.id),workspace:String(c.organizationUnitId),accounts:c.campaignAccountIds.map(String),name:neutralText(c.name).replace(/heyreach/gi,'LinkedIn').slice(0,500)||'LinkedIn campaign',
 status:({IN_PROGRESS:'active',DRAFT:'draft',PAUSED:'paused',FINISHED:'completed',COMPLETED:'completed',STOPPED:'stopped'} as Record<string,string>)[c.status]||'unknown'}))}
}
export async function discoverLinkedinCampaigns(signal:AbortSignal) {
 const db=createSupabaseAdminClient()
 const claim=await db.rpc('claim_outreach_linkedin_discovery').abortSignal(signal)
 if(claim.error) throw new Error('Campaign discovery unavailable')
 if(!claim.data) return
 const b=bindingSchema.parse(claim.data)
 const key=await resolveIntegrationCredential(b.credentialRef,process.env,db,signal)
 if(!key) throw new Error('Campaign discovery unavailable')
 const response=await fetch('https://api.heyreach.io/api/public/campaign/GetAll',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({offset:b.offset,limit:100}),signal,redirect:'error',cache:'no-store'})
 if(!response.ok) throw new Error('Campaign discovery unavailable')
 const page=scopedDiscoveredCampaigns(await response.json(),b.remoteWorkspaceId,b.senders.map(s=>s.remoteId))
 if(!page.items.length && page.totalCount>b.offset) throw new Error('Campaign discovery did not advance')
 const next=b.offset+page.items.length<page.totalCount?b.offset+page.items.length:undefined
 const saved=await db.rpc('save_outreach_linkedin_discovery',{p_workspace:b.workspaceId,p_version:b.workspaceVersion,p_claim:b.claim,p_senders:b.senders,p_campaigns:page.scoped,p_next_offset:next}).abortSignal(signal)
 if(saved.error) throw new Error('Campaign discovery could not be saved')
 console.info(JSON.stringify({event:'linkedin.campaigns.discovered',count:page.scoped.length,saved:saved.data===true}))
}
