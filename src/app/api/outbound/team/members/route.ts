import { createOutboundTeamHandlers } from '@/lib/outbound-team-api'

export const { changeMembership: PATCH } = createOutboundTeamHandlers()
