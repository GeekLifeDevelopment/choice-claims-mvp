export type ProviderMode = 'live' | 'stub' | 'unconfigured' | 'unavailable' | 'failed'

export type ProviderHealthEvent =
  | 'configured'
  | 'unconfigured'
  | 'stub_fallback'
  | 'live_success'
  | 'live_failure'
  | 'capability_unavailable'

export type ProviderHealthLogInput = {
  provider: string
  capability: string
  event: ProviderHealthEvent
  mode: ProviderMode
  vin?: string
  source?: string
  reason?: string
  status?: number
  details?: string
}

function toBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function isProviderHealthDebugEnabled(provider?: string): boolean {
  if (toBooleanEnv('PROVIDER_HEALTH_DEBUG')) {
    return true
  }

  if (provider?.toLowerCase() === 'autocheck') {
    return toBooleanEnv('AUTOCHECK_PROVIDER_DEBUG')
  }

  return false
}

export function logProviderHealth(input: ProviderHealthLogInput): void {
  if (!isProviderHealthDebugEnabled(input.provider)) {
    return
  }

  const payload: Record<string, unknown> = {
    provider: input.provider,
    capability: input.capability,
    event: input.event,
    mode: input.mode
  }

  if (input.vin) {
    payload.vin = input.vin
  }

  if (input.source) {
    payload.source = input.source
  }

  if (input.reason) {
    payload.reason = input.reason
  }

  if (typeof input.status === 'number') {
    payload.status = input.status
  }

  if (input.details) {
    payload.details = input.details
  }

  const message = '[PROVIDER_HEALTH]'

  if (input.event === 'live_failure' || input.event === 'capability_unavailable') {
    console.warn(message, payload)
    return
  }

  console.info(message, payload)
}
