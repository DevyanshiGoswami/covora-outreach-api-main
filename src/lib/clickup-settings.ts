import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { ApiError, checkDatabaseError, type OutboundApiConfig } from './outbound-http'
import { requireRuntimeDatabase } from './runtime-config'

export type ClickUpConfig = OutboundApiConfig & { serviceKey: string; clientId?: string; clientSecret?: string; redirectUri?: string; providerFetch?: typeof fetch }
export function clickUpSettings(config?: Pick<ClickUpConfig, 'clientId'|'clientSecret'|'redirectUri'>) {
 const clientId=config ? config.clientId : process.env.CLICKUP_CLIENT_ID
 const clientSecret=config ? config.clientSecret : process.env.CLICKUP_CLIENT_SECRET
 const redirectUri=config ? config.redirectUri : process.env.CLICKUP_REDIRECT_URI
 if (!clientId || !clientSecret || !redirectUri) return null
 if (!/^[^\s]{1,200}$/.test(clientId) || !/^[^\s]{8,4096}$/.test(clientSecret)) return null
 try {
  const url=new URL(redirectUri)
  if (redirectUri.length>2048 || url.username || url.password || url.search || url.hash || url.pathname!=='/auth/clickup/callback'
   || !(url.protocol==='https:' || process.env.NODE_ENV!=='production' && url.protocol==='http:' && url.hostname==='127.0.0.1')) return null
 } catch { return null }
 return { clientId,clientSecret,redirectUri }
}
/** A deployment-owned callback; forms cannot redirect client authorization elsewhere. */
export function clickUpRedirectUri(config?: ClickUpConfig) {
 const redirectUri=(config ? config.redirectUri : process.env.CLICKUP_REDIRECT_URI) || 'https://covora.app/auth/clickup/callback'
 if (!clickUpSettings({clientId:'validation',clientSecret:'validation-only',redirectUri})) throw new ApiError(500)
 return redirectUri
}
export function clickUpAdmin(config?: ClickUpConfig) {
 const runtime=config ?? requireRuntimeDatabase(true)
 if (!runtime.serviceKey) throw new ApiError(500)
 return createClient<Database>(runtime.url,runtime.serviceKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  try { return await (config?.fetch ?? fetch)(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)}) }
  catch { return Response.json({message:'Unavailable'},{status:503}) }
 }}})
}
export async function loadClickUpSettings(config?: ClickUpConfig) {
 const result=await clickUpAdmin(config).rpc('read_outreach_clickup_app');checkDatabaseError(result.error)
 const row=z.object({version:z.number().int().nonnegative(),clientId:z.string().nullable(),clientSecret:z.string().nullable(),redirectUri:z.string().nullable()}).parse(result.data)
 const settings=row.version===0 ? clickUpSettings(config) : clickUpSettings({clientId:row.clientId ?? undefined,clientSecret:row.clientSecret ?? undefined,redirectUri:row.redirectUri ?? undefined})
 return {version:row.version, settings:settings?.redirectUri===clickUpRedirectUri(config) ? settings : null}
}
