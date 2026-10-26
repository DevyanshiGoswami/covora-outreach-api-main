import { createDeveloperDataHandler } from '@/lib/developer-data'
export const runtime = 'nodejs'
export const GET = createDeveloperDataHandler()
export const HEAD = GET
export const POST = GET
