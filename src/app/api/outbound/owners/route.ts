import { createOwnerHandlers } from '@/lib/outbound-owner-api'

export const { list: GET, revokeOwner: DELETE } = createOwnerHandlers()
