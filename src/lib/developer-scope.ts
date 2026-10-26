import 'server-only'
import { ApiError, json, readJson, type OutboundApiConfig } from './outbound-http'
import { developmentRuntime, requireOwnedResource, type DeveloperSession } from './developer-session'

// New endpoints are denied until their resource ownership has been reviewed here.
const rules: Record<string, string[]> = {
 '/api/outbound/accounts': ['GET','POST'], '/api/outbound/accounts/verify': ['POST'],
 '/api/outbound/conversations': ['GET'], '/api/outbound/leads': ['GET'], '/api/outbound/leads/escrow': ['GET'],
 '/api/outbound/setup': ['GET','POST','PATCH'], '/api/outbound/team': ['GET'],
 '/api/outbound/team/invitations': ['POST','DELETE'], '/api/outbound/team/members': ['PATCH'],
 '/api/outbound/comments': ['GET','POST'], '/api/onboarding/people': ['GET','POST'],
 '/api/onboarding/invitations': ['POST'], '/api/onboarding/integrations': ['GET'],
}
export async function authorizeDevelopmentRequest(request: Request, scope: DeveloperSession, config?: OutboundApiConfig) {
 const url = new URL(request.url), path = url.pathname, method = request.method
 if (path === '/api/onboarding/context' && method === 'GET' && !url.search) return
 if (path === '/api/onboarding/connections' && method === 'POST') {
   const body = await readJson(request.clone()) as Record<string, unknown>
   if (!body || typeof body !== 'object') throw new ApiError(403)
   const { admin } = developmentRuntime(config)
   await requireOwnedResource(admin, 'connectionId' in body ? 'outreach_connections' : 'outreach_people', body.connectionId ?? body.personId, scope.clientId)
   return
 }
 const conversation = /^\/api\/outbound\/conversations\/[a-f0-9-]{36}(?:\/(reply|owner|read))?$/.exec(path)
 const comment = /^\/api\/outbound\/comments\/[a-f0-9-]{36}(?:\/(replies))?$/.exec(path)
 const methods = rules[path] ?? (conversation ? conversation[1] ? ['POST'] : ['GET'] : comment ? comment[1] ? ['POST'] : ['GET','PATCH'] : [])
 if (!methods.includes(method)) throw new ApiError(403)
 if (method === 'GET') {
   const ids = url.searchParams.getAll('clientId')
   if (ids.length !== 1 || ids[0] !== scope.clientId) throw new ApiError(403)
   return
 }
 const body = await readJson(request.clone(), path.includes('/comments') ? 32768 : 8192) as Record<string, unknown>
 if (!body || typeof body !== 'object') throw new ApiError(403)
 if (path === '/api/outbound/setup' && method === 'PATCH') {
   await requireOwnedResource(developmentRuntime(config).admin, 'outreach_setup_requests', body.requestId, scope.clientId)
 } else if (path === '/api/outbound/team/invitations' && method === 'DELETE') {
   await requireOwnedResource(developmentRuntime(config).admin, 'outreach_invitations', body.invitationId, scope.clientId)
 } else if (body.clientId !== scope.clientId) throw new ApiError(403)
}
export async function scopeDevelopmentResponse(request: Request, response: Response, scope: DeveloperSession) {
 if (!response.ok) return response
 const path = new URL(request.url).pathname
 if (path === '/api/onboarding/context') {
   const body = await response.json()
   return json({ userId: scope.userId, isOwner: true, canManageClients: false,
     workspaces: Array.isArray(body.workspaces) ? body.workspaces.filter((row: {id: string}) => row.id === scope.clientId) : [] })
 }
 if (path === '/api/onboarding/integrations') {
   const body = await response.json()
   // Existing assignments are enough to connect accounts. Do not expose the
   // agency's catalog or offer rebinding a shared integration from local code.
   return json({ status: body.status, options: [] })
 }
 return response
}
