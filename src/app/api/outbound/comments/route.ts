import { createOutboundCommentsHandlers } from '@/lib/outbound-comments-api'

export const { list: GET, create: POST } = createOutboundCommentsHandlers()
