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
  const debugEnabled = isProviderHealthDebugEnabled(input.provider)

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

  const compactMessage = `[provider] ${input.provider} ${input.capability} ${input.event}`
  const compactPayload: Record<string, unknown> = {
    mode: input.mode
  }

  if (input.reason) {
    compactPayload.reason = input.reason
  }

  if (typeof input.status === 'number') {
    compactPayload.status = input.status
  }

  if (input.vin) {
    compactPayload.vin = input.vin
  }

  const shouldWarn = input.event === 'live_failure' || input.event === 'capability_unavailable'

  if (shouldWarn) {
    console.warn(compactMessage, compactPayload)
  } else {
    console.info(compactMessage, compactPayload)
  }

  if (!debugEnabled) {
    return
  }

  const message = '[PROVIDER_HEALTH]'

  if (shouldWarn) {
    console.warn(message, payload)
    return
  }

  console.info(message, payload)
}
