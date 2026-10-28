import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createSupabaseAdminClient } from './supabase/admin'
import { readJson } from './outbound-http'

type Receiver = (workspace: string, secretHash: string | null, payloadHash: string) => Promise<boolean>
export function createLinkedinWebhook(receive?: Receiver) {
 return async (request: Request, workspace: string) => {
  const secret=request.headers.get('x-covora-webhook-secret')
  const reply=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store'}})
  if(!z.uuid().safeParse(workspace).success || (secret !== null && !/^[a-f0-9]{64}$/.test(secret)) || new URL(request.url).search) return reply(401)
  let payload: unknown
  try { payload=await readJson(request,65536) } catch { return reply(400) }
  if(!payload || typeof payload!=='object' || Array.isArray(payload)) return reply(400)
  const sha=(v:string)=>createHash('sha256').update(v).digest('hex')
  try {
   const store:Receiver=receive ?? (async (id,hash,bodyHash)=>{
    const db=createSupabaseAdminClient()
    const result=await (hash === null
     ? db.rpc('receive_outreach_linkedin_hint',{p_workspace:id,p_payload_hash:bodyHash})
     : db.rpc('receive_outreach_linkedin_hook',{p_workspace:id,p_secret_hash:hash,p_payload_hash:bodyHash})).abortSignal(AbortSignal.timeout(4000))
    if(result.error) throw new Error('Webhook unavailable')
    return result.data===true
   })
   const accepted=await store(workspace,secret === null ? null : sha(secret),sha(JSON.stringify(payload)))
   console.info(JSON.stringify({event:'linkedin.webhook.received',accepted,mode:secret===null?'unverified_hint':'authenticated'}))
   return reply(accepted?204:401)
  } catch {
   console.warn(JSON.stringify({event:'linkedin.webhook.failed'}))
   return reply(503)
  }
 }
}
