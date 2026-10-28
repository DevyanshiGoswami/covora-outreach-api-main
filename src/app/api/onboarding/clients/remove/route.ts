import { createOnboardingHandlers } from '@/lib/onboarding-api'
export const runtime = 'nodejs'
export const POST = createOnboardingHandlers().removeClient
