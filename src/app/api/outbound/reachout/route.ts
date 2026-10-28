import { createReachoutHandlers } from '@/lib/lead-reachout-api'
export const dynamic = 'force-dynamic'
export const maxDuration = 120
export const { GET, POST } = createReachoutHandlers()
