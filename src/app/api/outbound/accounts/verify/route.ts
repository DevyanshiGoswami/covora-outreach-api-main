import { createOutboundAccountHandlers } from '@/lib/outbound-accounts-api'

export const POST = createOutboundAccountHandlers().verify
