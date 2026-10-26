import { createDeveloperHandlers } from '@/lib/developer-session'
export const runtime = 'nodejs'
const handlers = createDeveloperHandlers()
export const POST = handlers.issue
export const GET = handlers.session
export const DELETE = handlers.signout
