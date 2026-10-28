import { createOnboardingHandlers } from '@/lib/onboarding-api'

export const runtime = 'nodejs'
const handlers = createOnboardingHandlers()
export const GET = handlers.people
export const POST = handlers.addPerson
