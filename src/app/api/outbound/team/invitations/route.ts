import { createOutboundTeamHandlers } from '@/lib/outbound-team-api'

export const { createInvitation: POST, revokeInvitation: DELETE } = createOutboundTeamHandlers()
