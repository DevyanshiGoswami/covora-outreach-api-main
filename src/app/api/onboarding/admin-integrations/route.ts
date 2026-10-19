import { createAdminIntegrationHandlers } from '@/lib/admin-integrations-api'
export const runtime = 'nodejs'
const handlers = createAdminIntegrationHandlers()
export const GET = handlers.GET
export const POST = handlers.POST
