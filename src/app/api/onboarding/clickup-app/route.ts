import { createClickUpAdminHandlers } from '@/lib/clickup-admin-api'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const { GET,POST }=createClickUpAdminHandlers()
