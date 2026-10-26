import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { requireRuntimeDatabase } from './runtime-config'
import { ApiError, checkDatabaseError, json, type OutboundApiConfig } from './outbound-http'

export type DeveloperConfig = { enabled: boolean; clientId: string; serviceKey: string }
const sessionSchema = z.object({ userId: z.uuid(), email: z.email(), clientId: z.uuid(), clientName: z.string().max(200), expiresAt: z.string().datetime({ offset: true }), bearer: z.string().min(20).max(16384) })
export type DeveloperSession = z.infer<typeof sessionSchema>
export const developmentTokenPattern = /^cdev_[A-Za-z0-9_-]{43}$/
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export function developmentRuntime(config?: OutboundApiConfig) {
  const settings = config?.development ?? { enabled: process.env.OUTREACH_DEVELOPMENT_GATEWAY_ENABLED === 'true', clientId: process.env.OUTREACH_DEVELOPMENT_CLIENT_ID ?? '', serviceKey: '' }
  if (!settings.enabled || !z.uuid().safeParse(settings.clientId).success) throw new ApiError(403)
  const runtime = config ?? requireRuntimeDatabase(true)
  const serviceKey = config ? settings.serviceKey : requireRuntimeDatabase(true).serviceKey
  if (!serviceKey) throw new ApiError(500)
  const transport: typeof fetch = async (input, init) => {
    try { return await (config?.fetch ?? fetch)(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(8000), ...(init?.signal ? [init.signal] : [])]) }) }
    catch { return Response.json({ message: 'Unavailable' }, { status: 503 }) }
  }
  const admin = createClient<Database>(runtime.url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } })
  return { ...runtime, clientId: settings.clientId, admin, transport }
}
export async function resolveDeveloperSession(token: string, config?: OutboundApiConfig): Promise<DeveloperSession> {
  if (!developmentTokenPattern.test(token)) throw new ApiError(401)
  const { admin, clientId } = developmentRuntime(config)
  const read = await admin.rpc('read_outreach_developer_session', { p_hash: tokenHash(token), p_client: clientId })
  checkDatabaseError(read.error)
  const session = sessionSchema.safeParse(read.data)
  if (!session.success || session.data.clientId !== clientId || Date.parse(session.data.expiresAt) <= Date.now()) throw new ApiError(401)
  return session.data
}
export function publicDeveloperSession(session: DeveloperSession) {
  return { userId: session.userId, email: session.email, clientId: session.clientId, clientName: session.clientName, expiresAt: session.expiresAt }
}
export function createDeveloperHandlers(config?: OutboundApiConfig) {
  async function execute(request: Request) {
    try {
      if (new URL(request.url).search) throw new ApiError(400)
      const { admin, clientId, url, anonKey, transport } = developmentRuntime(config)
      const token = request.headers.get('authorization')?.match(/^Bearer ([^\s,]+)$/i)?.[1]
      if (!token || token.length > 16384) throw new ApiError(401)
      if (request.method === 'DELETE') {
        if (!developmentTokenPattern.test(token)) throw new ApiError(401)
        checkDatabaseError((await admin.rpc('revoke_outreach_developer_session', { p_hash: tokenHash(token) })).error)
        return json({ ok: true })
      }
      if (request.method === 'GET') return json(publicDeveloperSession(await resolveDeveloperSession(token, config)))
      if (request.method !== 'POST' || token.startsWith('cdev_')) throw new ApiError(401)
      const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } })
      const verified = await client.auth.getUser(token)
      if (verified.error || !verified.data.user) throw new ApiError(401)
      // Read claims only after central Auth verified this exact bearer.
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      if (!Number.isSafeInteger(claims.exp) || claims.sub !== verified.data.user.id || claims.role !== 'authenticated') throw new ApiError(401)
      const scoped = `cdev_${randomBytes(32).toString('base64url')}`
      const issued = await admin.rpc('issue_outreach_developer_session', { p_user: verified.data.user.id, p_client: clientId,
        p_hash: tokenHash(scoped), p_bearer: token, p_expires: new Date(claims.exp * 1000).toISOString() })
      checkDatabaseError(issued.error)
      return json({ ...publicDeveloperSession(await resolveDeveloperSession(scoped, config)), token: scoped }, 201)
    } catch (error) { return json({ error: 'Development access is unavailable for this session.' }, error instanceof ApiError ? error.status : 500) }
  }
  return { issue: execute, session: execute, signout: execute }
}

export async function requireOwnedResource(admin: SupabaseClient<Database>, table: 'outreach_people' | 'outreach_connections' | 'outreach_setup_requests' | 'outreach_invitations', id: unknown, clientId: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError(403)
  const result = await admin.from(table).select('client_id').eq('id', id as string).eq('client_id', clientId).maybeSingle()
  checkDatabaseError(result.error)
  if (!result.data) throw new ApiError(403)
}
