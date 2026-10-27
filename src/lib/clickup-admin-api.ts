import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson } from './outbound-http'
import { portalContextSchema } from './onboarding-contract'
import { clickUpAdmin, clickUpRedirectUri, clickUpSettings, type ClickUpConfig } from './clickup-settings'

const bodySchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('save'),version:z.number().int().nonnegative(),clientId:z.string().trim().min(1).max(200).regex(/^[^\s]+$/),clientSecret:z.string().trim().min(8).max(4096).regex(/^[^\s]+$/)}),
 z.strictObject({action:z.literal('disable'),version:z.number().int().nonnegative()}),
])
export function createClickUpAdminHandlers(config?: ClickUpConfig) {
 const handle=createOutboundHandler(config,{401:'Sign in to manage app settings.',400:'Settings changed, or a different app still has connected clients. Refresh before trying again.',403:'Only agency owners can configure the ClickUp app.',500:'ClickUp app settings are unavailable. Please try again.'})
 const run=handle(async(request,client)=>{
  if(new URL(request.url).search) throw new ApiError(400)
  const context=await client.rpc('outreach_portal_context');checkDatabaseError(context.error)
  const actor=portalContextSchema.parse(context.data);if(!actor.isOwner)throw new ApiError(403)
  const admin=clickUpAdmin(config)
  const membership=await admin.from('outreach_agency_memberships').select('version').eq('user_id',actor.userId).eq('state','active').single();checkDatabaseError(membership.error)
  if(!membership.data)throw new ApiError(403)
  const redirectUri=clickUpRedirectUri(config)
  if(request.method==='GET') {
   const result=await admin.from('outreach_clickup_app').select('version,secret_id,redirect_uri,updated_at').eq('singleton',true).single();checkDatabaseError(result.error)
   if(!result.data)throw new ApiError(500)
   const row=result.data, environment=row.version===0 ? clickUpSettings(config) : null
   return json({version:row.version,configured:row.version===0 ? Boolean(environment && environment.redirectUri===redirectUri) : Boolean(row.secret_id && row.redirect_uri===redirectUri),
    source:row.version===0 ? environment ? 'environment' : 'none' : 'admin',redirectUri,updatedAt:row.updated_at})
  }
  const parsed=bodySchema.safeParse(await readJson(request));if(!parsed.success)throw new ApiError(400)
  const value=parsed.data, args={p_actor:actor.userId,p_actor_version:membership.data.version,p_version:value.version}
  const result=value.action==='save' ? await admin.rpc('save_outreach_clickup_app',{...args,p_client_id:value.clientId,p_secret:value.clientSecret,p_redirect_uri:redirectUri})
   : await admin.rpc('disable_outreach_clickup_app',args)
  checkDatabaseError(result.error)
  return json({ok:true})
 })
 return {GET:run,POST:run}
}
