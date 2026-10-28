import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createOutboundHandler, checkDatabaseError as checkDatabaseResult, readJson, json, ApiError, type OutboundApiConfig } from './outbound-http'
import { createSupabaseAdminClient } from './supabase/admin'
import { resolveIntegrationCredential } from './integration-credentials'
import { reachoutLog, bindReachoutLog } from './reachout-log'
import { dispatchReachout, observeReachout, ReachoutFailure } from './lead-reachout-provider'

const commandSchema = z.object({ id: z.uuid(), clientId: z.uuid(), leadId: z.uuid(), senderId: z.uuid(), channel: z.enum(['email','linkedin']), recipient: z.string(), recipientName: z.string(), subject: z.string(), body: z.string(), status: z.string() })
const bindingSchema = z.object({ command: commandSchema, remoteSender: z.string(), workspace: z.string(), credentialRef: z.string() })
const inputSchema = z.discriminatedUnion('action',[
 z.strictObject({ action: z.literal('send'), clientId: z.uuid(), leadId: z.uuid(), senderId: z.uuid(), commandId: z.uuid(), recipient: z.string().max(500), subject: z.string().max(200), body: z.string().max(4000) }),
 z.strictObject({ action: z.literal('refresh'), clientId: z.uuid(), commandId: z.uuid() }),
])
type Config = OutboundApiConfig & { admin?: ReturnType<typeof createSupabaseAdminClient>; providerFetch?: typeof fetch; credentials?: Record<string,string>; enabled?: boolean }
const messages = { 400: 'Review the recipient and message, or check existing outreach before sending again.', 401: 'Sign in again to continue.', 403: 'Outreach sending is unavailable for this workspace or account.', 500: 'Outreach could not be loaded. Check the request history before trying again.' } as const

function checkDatabaseError(error: {code:string}|null) {
 if(error)reachoutLog('database.rejected',{code:error.code})
 checkDatabaseResult(error)
}

export function createReachoutHandlers(config?: Config) {
 const handle = createOutboundHandler(config,messages,105000)
 const service = () => config?.admin ?? createSupabaseAdminClient()
 const enabled = () => config?.enabled ?? process.env.OUTREACH_COMPOSE_ENABLED === 'true'
 return {
  GET: handle(async (request,client) => {
   const url = new URL(request.url)
   if ([...url.searchParams.keys()].some(k=>!['clientId','leadId','channel'].includes(k)) || ['clientId','leadId','channel'].some(k=>url.searchParams.getAll(k).length>1)) throw new ApiError(400)
   const input = z.object({ clientId: z.uuid(), leadId: z.uuid().optional(), channel: z.enum(['email','linkedin']).optional() }).safeParse(Object.fromEntries(url.searchParams))
   if (!input.success) throw new ApiError(400)
   bindReachoutLog({clientId:input.data.clientId})
   reachoutLog('context.loading')
   const result = await client.rpc('get_outreach_compose',{ p_client: input.data.clientId, p_lead: input.data.leadId, p_channel: input.data.channel })
   checkDatabaseError(result.error)
   const data = z.object({ clientId: z.uuid(), senders: z.array(z.object({ enabled: z.boolean() }).passthrough()) }).passthrough().parse(result.data)
   if (!input.data.leadId && input.data.channel !== 'email') {
    const tracked=await client.rpc('get_outreach_linkedin_tracking',{p_client:input.data.clientId})
    checkDatabaseError(tracked.error)
    const combined=[...(Array.isArray(data.history)?data.history:[]),...(Array.isArray(tracked.data)?tracked.data:[])]
    data.history=combined.sort((a,b)=>Date.parse(String(b.createdAt))-Date.parse(String(a.createdAt))).slice(0,100)
   }
   reachoutLog('context.loaded',{count:data.senders.length,enabledCount:data.senders.filter(s=>s.enabled&&enabled()).length})
   return json({ ...data, senders: data.senders.map(s=>({...s,enabled:s.enabled && enabled()})) })
  }),
  POST: handle(async (request,client) => {
   if (new URL(request.url).search) throw new ApiError(400)
   const parsed=inputSchema.safeParse(await readJson(request,24000))
   if(!parsed.success) throw new ApiError(400)
   const input=parsed.data
   bindReachoutLog({clientId:input.clientId,commandId:input.commandId})
   reachoutLog(input.action==='send'?'command.received':'refresh.started')
   const admin=service()
   if(input.action==='refresh') {
    // Authenticate and check the workspace before privileged lookup.
    const access=await client.rpc('get_outreach_compose',{p_client:input.clientId})
    checkDatabaseError(access.error)
    const saved=await admin.from('outreach_compose_commands').select('*').eq('id',input.commandId).eq('client_id',input.clientId).maybeSingle()
    checkDatabaseError(saved.error)
    if(!saved.data)throw new ApiError(403)
    const c=saved.data
    if(c.remote_campaign_id && !['failed','replied'].includes(c.status) && (!c.checked_at || Date.now()-Date.parse(c.checked_at)>15000)) {
     const sender=await admin.from('outreach_reply_senders').select('remote_sender_id,workspace_id,version').eq('id',c.sender_id).eq('client_id',input.clientId).single()
     checkDatabaseError(sender.error)
     if(!sender.data)throw new ApiError(403)
     const workspace=await admin.from('outreach_reply_workspaces').select('remote_workspace_id,credential_ref,version').eq('id',sender.data.workspace_id).eq('client_id',input.clientId).single()
     checkDatabaseError(workspace.error)
     if(!workspace.data || workspace.data.version!==c.workspace_version)throw new ApiError(403)
     const key=await resolveIntegrationCredential(workspace.data.credential_ref,config?.credentials??process.env,admin)
     if(!key)throw new ApiError(500)
     let status: Awaited<ReturnType<typeof observeReachout>>
     try {
      status=await observeReachout({id:c.id,channel:z.enum(['email','linkedin']).parse(c.channel),recipient:c.recipient,recipientName:c.recipient_name,subject:c.subject,body:c.body_text},
       {remoteSender:sender.data.remote_sender_id,workspace:workspace.data.remote_workspace_id},c.remote_campaign_id,{key,fetch:config?.providerFetch})
     } catch { reachoutLog('refresh.unconfirmed');return json({error:'Status could not be confirmed. The saved request has been retained.'},503) }
     const rank: Record<string,number>={preparing:0,unknown:0,queued:1,sent:2,connected:3,replied:4,failed:0}
     const next=status && (status==='failed' && ['preparing','queued'].includes(c.status) || rank[status]>rank[c.status]) ? status : c.status
     const updated=await admin.from('outreach_compose_commands').update({status:next,checked_at:new Date().toISOString(),...(next!==c.status?{updated_at:new Date().toISOString()}: {})}).eq('id',c.id).eq('status',c.status)
     checkDatabaseError(updated.error)
     reachoutLog('refresh.saved',{status:next})
    }
    const result=await client.rpc('get_outreach_compose',{p_client:input.clientId,p_lead:c.lead_id})
    checkDatabaseError(result.error)
    reachoutLog('refresh.finished')
    return json(result.data)
   }
   if(!enabled()){reachoutLog('command.disabled');throw new ApiError(403)}
   reachoutLog('command.preparing')
   const prepared=await client.rpc('prepare_outreach_compose',{p_client:input.clientId,p_lead:input.leadId,p_sender:input.senderId,p_command:input.commandId,p_recipient:input.recipient,p_subject:input.subject,p_body:input.body})
   checkDatabaseError(prepared.error)
   const command=commandSchema.parse(prepared.data)
   if(command.status!=='preparing'){reachoutLog('command.existing',{status:command.status});return json({command:prepared.data})}
   reachoutLog('command.claiming')
   const claim=randomUUID()
   const claimed=await admin.rpc('authorize_outreach_compose',{p_command:input.commandId,p_claim:claim,p_claim_first:true})
   checkDatabaseError(claimed.error)
   if(!claimed.data){reachoutLog('command.claim_refused');return json({command:prepared.data})}
   reachoutLog('command.claimed')
   const binding=bindingSchema.parse(claimed.data)
   const key=await resolveIntegrationCredential(binding.credentialRef,config?.credentials??process.env,admin)
   let status:'queued'|'failed'|'unknown'='failed',errorCode:string|null=null
   try {
    if(!key){reachoutLog('credential.unavailable');throw new ReachoutFailure('account_unavailable')}
    reachoutLog('command.dispatching',{channel:binding.command.channel})
    await dispatchReachout(binding.command,binding,{key,fetch:config?.providerFetch,
     authorize:async()=>{reachoutLog('command.reauthorizing');if(!enabled())throw new ReachoutFailure('provider_rejected');const check=await admin.rpc('authorize_outreach_compose',{p_command:input.commandId,p_claim:claim});checkDatabaseError(check.error);if(!check.data)throw new ReachoutFailure('provider_rejected')},
     checkpoint:async(campaign,list)=>{
      reachoutLog('command.checkpointing')
      const saved=await admin.rpc('checkpoint_outreach_compose',{p_command:input.commandId,p_claim:claim,p_campaign:campaign,p_list:list})
      checkDatabaseError(saved.error);if(saved.data!==true)throw new Error()
     },
    })
    status='queued'
   } catch(error) { status=error instanceof ReachoutFailure && !error.uncertain ? 'failed':'unknown';errorCode=error instanceof ReachoutFailure?error.code:'outcome_unknown';reachoutLog('command.dispatch_failed',{status,code:errorCode}) }
   reachoutLog('command.saving',{status})
   const saved=await admin.from('outreach_compose_commands').update({status,error_code:errorCode,updated_at:new Date().toISOString()}).eq('id',input.commandId).eq('claim_token',claim).eq('status','preparing')
   checkDatabaseError(saved.error)
   checkDatabaseError((await admin.from('outreach_campaigns').update({status:status==='queued'?'active':status==='unknown'?'unknown':'draft'}).eq('id',input.commandId).eq('client_id',input.clientId)).error)
   const result=await client.rpc('get_outreach_compose',{p_client:input.clientId,p_lead:input.leadId})
   checkDatabaseError(result.error)
   reachoutLog('command.saved',{status,code:errorCode})
   return json({context:result.data,failureCode:errorCode})
  }),
 }
}
