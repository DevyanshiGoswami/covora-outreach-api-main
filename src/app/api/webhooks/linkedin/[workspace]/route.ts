import { createLinkedinWebhook } from '@/lib/linkedin-webhook'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=10
const receive=createLinkedinWebhook()
export async function POST(request:Request,{params}:{params:Promise<{workspace:string}>}) {
 return receive(request,(await params).workspace)
}
