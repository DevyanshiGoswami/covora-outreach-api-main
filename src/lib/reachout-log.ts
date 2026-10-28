import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { normalizeProviderPath } from './provider-call-log'

type Scope = { requestId: string; commandId?: string; clientId?: string }
const scope = new AsyncLocalStorage<Scope>()
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
type Fields = { status?: number | string | null; durationMs?: number; operation?: string; channel?: string; code?: string | null; count?: number; enabledCount?: number; fields?: string[] }
/** Explicit metadata allowlist. No request bodies, identities, keys or raw errors. */
export function reachoutLog(event: string, fields: Fields = {}) {
 const safe: Record<string,unknown> = { event, ...scope.getStore() }
 if(typeof fields.status==='number'||fields.status===null||typeof fields.status==='string'&&/^[a-z_]{1,30}$/.test(fields.status))safe.status=fields.status
 if(typeof fields.durationMs==='number')safe.durationMs=Math.max(0,Math.round(fields.durationMs))
 if(fields.operation)safe.operation=normalizeProviderPath(fields.operation)
 if(fields.channel==='email'||fields.channel==='linkedin')safe.channel=fields.channel
 if(fields.code&&/^[a-zA-Z0-9_]{1,40}$/.test(fields.code))safe.code=fields.code
 if(typeof fields.count==='number')safe.count=fields.count
 if(typeof fields.enabledCount==='number')safe.enabledCount=fields.enabledCount
 if(fields.fields)safe.fields=fields.fields.filter(v=>/^[A-Za-z0-9_.\[\]]{1,100}$/.test(v)).slice(0,20)
 console.info('[outreach]',JSON.stringify(safe))
}
export function bindReachoutLog(values: {commandId?:string;clientId?:string}) {
 const current=scope.getStore();if(!current)return
 if(uuid(values.commandId))current.commandId=values.commandId
 if(uuid(values.clientId))current.clientId=values.clientId
}
export async function traceReachout(request: Request, operation:()=>Promise<Response>) {
 const supplied=request.headers.get('x-covora-request-id')
 return scope.run({requestId:uuid(supplied)?supplied:randomUUID()},async()=>{
  const start=Date.now();reachoutLog('request.started',{operation:request.method==='GET'?'load':'submit'})
  const response=await operation()
  response.headers.set('x-covora-request-id',scope.getStore()!.requestId)
  reachoutLog('request.finished',{status:response.status,durationMs:Date.now()-start})
  return response
 })
}
/** Only validation field names are retained, never provider messages or values. */
export async function providerValidationFields(response: Response): Promise<string[]> {
 const reader=response.clone().body?.getReader();if(!reader)return []
 try {
  let text='';const decoder=new TextDecoder()
  while(true){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});if(text.length>8192){void reader.cancel().catch(()=>{});return []}}
  const parsed=JSON.parse(text)
  return parsed?.errors&&typeof parsed.errors==='object'&&!Array.isArray(parsed.errors)?Object.keys(parsed.errors).filter(k=>/^[A-Za-z0-9_.\[\]]{1,100}$/.test(k)).slice(0,20):[]
 }catch{return []}finally{reader.releaseLock()}
}
