import { createOnboardingHandlers } from '@/lib/onboarding-api'

export const runtime = 'nodejs'
const handlers = createOnboardingHandlers()
export const POST = handlers.invite
