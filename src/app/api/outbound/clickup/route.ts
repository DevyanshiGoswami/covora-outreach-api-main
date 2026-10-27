import { createClickUpHandlers } from '@/lib/clickup-api'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const { GET,POST }=createClickUpHandlers()
