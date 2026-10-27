import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson } from './outbound-http'
import { clickUpAdmin, clickUpSettings, loadClickUpSettings, type ClickUpConfig } from './clickup-settings'
export { clickUpSettings, type ClickUpConfig } from './clickup-settings'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const bodySchema = z.discriminatedUnion('action', [
 z.strictObject({ action: z.literal('start'), clientId: z.uuid(), browserProof: nonce }),
 z.strictObject({ action: z.literal('complete'), clientId: z.uuid(), browserProof: nonce, state: nonce, code: z.string().min(1).max(2048).regex(/^[^\s]+$/) }),
 z.strictObject({ action: z.literal('disconnect'), clientId: z.uuid(), version: z.number().int().nonnegative() }),
])
const workspacesSchema=z.object({ teams:z.array(z.object({ id:z.string().min(1).max(200), name:z.string().min(1).max(200) })).min(1).max(100) })
export async function exchangeClickUpCode(code:string, settings:NonNullable<ReturnType<typeof clickUpSettings>>, fetcher:typeof fetch=fetch) {
 const options={cache:'no-store' as const,redirect:'error' as const,signal:AbortSignal.timeout(15000)}
 const exchanged=await fetcher('https://api.clickup.com/api/v2/oauth/token',{...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:settings.clientId,client_secret:settings.clientSecret,code})})
 if (!exchanged.ok) throw new ApiError(400)
 const {access_token:token}=z.object({access_token:z.string().min(8).max(8192).regex(/^[^\s]+$/)}).parse(await exchanged.json())
 const result=await fetcher('https://api.clickup.com/api/v2/team',{...options,signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`}})
 if (!result.ok) throw new ApiError(400)
 const {teams}=workspacesSchema.parse(await result.json())
 if(new Set(teams.map(team=>team.id)).size!==teams.length) throw new ApiError(400)
 return { token,workspaces:teams }
}
export function createClickUpHandlers(config?:ClickUpConfig) {
 const handle=createOutboundHandler(config,{400:'The connection could not be completed. Start again.',401:'Sign in to manage this connection.',403:'Only a current client administrator or agency owner can manage this connection.',500:'ClickUp authorization is unavailable. Please try again later.'})
 return {
  GET:handle(async(request,client)=>{
   const entries=[...new URL(request.url).searchParams]
   const parsed=z.strictObject({clientId:z.uuid()}).safeParse(Object.fromEntries(entries))
   if(entries.length!==1 || !parsed.success) throw new ApiError(400)
   const result=await client.rpc('outreach_crm_status',{p_client_id:parsed.data.clientId}); checkDatabaseError(result.error)
   const status=z.object({canManage:z.boolean(),connected:z.boolean(),connectedAt:z.string().nullable(),version:z.number().int().nonnegative(),workspaces:z.array(z.object({name:z.string().max(200)})).max(100)}).parse(result.data)
   return json({...status,configured:Boolean((await loadClickUpSettings(config)).settings)})
  }),
  POST:handle(async(request,client)=>{
   if(new URL(request.url).search) throw new ApiError(400)
   const parsed=bodySchema.safeParse(await readJson(request)); if(!parsed.success) throw new ApiError(400)
   const value=parsed.data
   if(value.action==='disconnect') {
    const result=await client.rpc('disconnect_outreach_crm',{p_client_id:value.clientId,p_version:value.version}); checkDatabaseError(result.error)
    return json({ok:true})
   }
   const {settings,version:appVersion}=await loadClickUpSettings(config); if(!settings) throw new ApiError(500)
   if(value.action==='start') {
    const state=randomBytes(32).toString('base64url')
    const result=await client.rpc('begin_outreach_crm_authorization',{p_client_id:value.clientId,p_state_hash:digest(state),p_browser_hash:digest(value.browserProof),p_app_version:appVersion}); checkDatabaseError(result.error)
    const url=new URL('https://app.clickup.com/api'); url.searchParams.set('client_id',settings.clientId); url.searchParams.set('redirect_uri',settings.redirectUri); url.searchParams.set('state',state)
    return json({authorizationUrl:url.toString(),state})
   }
   const consumed=await client.rpc('consume_outreach_crm_authorization',{p_client_id:value.clientId,p_state_hash:digest(value.state),p_browser_hash:digest(value.browserProof),p_app_version:appVersion}); checkDatabaseError(consumed.error)
   const attempt=z.uuid().parse(consumed.data)
   const authorization=await exchangeClickUpCode(value.code,settings,config?.providerFetch)
   const admin=clickUpAdmin(config)
   const saved=await admin.rpc('complete_outreach_crm_authorization',{p_attempt_id:attempt,p_token:authorization.token,p_workspaces:authorization.workspaces}); checkDatabaseError(saved.error)
   return json({ok:true})
  }),
 }
}
