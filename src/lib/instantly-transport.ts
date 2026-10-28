import 'server-only'
import { mockInstantlyFetch } from './instantly-mock'

type Environment = Readonly<Record<string, string | undefined>>
export type InstantlyMode = 'live' | 'mock'

/** Mock mode is a development-only transport; it never reaches the network. */
export function instantlyMode(env: Environment = process.env): InstantlyMode {
  const mode = env.OUTREACH_INSTANTLY_MODE?.trim().toLowerCase() || 'live'
  if (mode !== 'live' && mode !== 'mock') throw new Error('Unsupported sending-engine mode')
  if (mode === 'mock' && env.NODE_ENV === 'production') throw new Error('Mock sending engine is unavailable in production')
  return mode
}

export function instantlyTransport(env: Environment = process.env): typeof fetch {
  return instantlyMode(env) === 'mock' ? mockInstantlyFetch : fetch
}
