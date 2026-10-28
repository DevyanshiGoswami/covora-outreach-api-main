import { createOutboundTeamHandlers } from '@/lib/outbound-team-api'

export const { acceptInvitation: POST } = createOutboundTeamHandlers()
