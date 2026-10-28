import 'server-only'
import { runtimeConfiguration } from './runtime-config'

/** Configuration readiness only; never claims that a database/provider call passed. */
export function configurationHealth(env: Readonly<Record<string, string | undefined>> = process.env) {
  const config = runtimeConfiguration(env)
  const ready = config.databaseTargetValid && config.publicCredentialConfigured && config.serviceCredentialConfigured
  return {
    service: 'covora-outreach-api', ready, check: 'configuration',
    databaseTargetValid: config.databaseTargetValid,
    credentialsConfigured: config.publicCredentialConfigured && config.serviceCredentialConfigured,
    sendingEnabled: config.repliesEnabled, synchronizationEnabled: config.syncEnabled, notificationsEnabled: config.alertsEnabled,
  }
}
