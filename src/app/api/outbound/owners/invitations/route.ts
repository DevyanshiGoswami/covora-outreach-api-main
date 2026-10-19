import { createOwnerHandlers } from '@/lib/outbound-owner-api'

export const { invite: POST, revokeInvitation: DELETE } = createOwnerHandlers()
