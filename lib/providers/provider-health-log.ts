import { classifyExternalFailure } from './failure-classification'

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
  claimId?: string
  jobId?: string
  stage?: string
  action?: string
  vin?: string
  source?: string
  reason?: string
  status?: number
  details?: string
}

export type ProviderHealthStatus = 'configured' | 'stub' | 'missing_config' | 'error' | 'ok'

export type ProviderHealthStatusInput = {
  configured?: boolean
  mode?: ProviderMode
  event?: ProviderHealthEvent
  source?: string | null
  error?: string | null
  hasData?: boolean
}

function hasStubSource(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  return value.toLowerCase().includes('stub')
}

export function getProviderHealthStatus(input: ProviderHealthStatusInput): ProviderHealthStatus {
  if (input.error && input.error.trim().length > 0) {
    return 'error'
  }

  if (
    input.mode === 'failed' ||
    input.mode === 'unavailable' ||
    input.event === 'live_failure' ||
    input.event === 'capability_unavailable'
  ) {
    return 'error'
  }

  if (input.mode === 'stub' || input.event === 'stub_fallback' || hasStubSource(input.source)) {
    return 'stub'
  }

  if (input.mode === 'unconfigured' || input.event === 'unconfigured' || input.configured === false) {
    return 'missing_config'
  }

  if (input.event === 'configured') {
    return 'configured'
  }

  if (input.event === 'live_success' || input.hasData) {
    return 'ok'
  }

  if (input.configured === true) {
    return 'configured'
  }

  return 'ok'
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
  const status = getProviderHealthStatus({
    mode: input.mode,
    event: input.event,
    source: input.source ?? null,
    configured: input.mode !== 'unconfigured'
  })

  const payload: Record<string, unknown> = {
    provider: input.provider,
    capability: input.capability,
    event: input.event,
    mode: input.mode
  }

  if (input.vin) {
    payload.vin = input.vin
  }

  if (input.claimId) {
    payload.claimId = input.claimId
  }

  if (input.jobId) {
    payload.jobId = input.jobId
  }

  if (input.stage) {
    payload.stage = input.stage
  }

  if (input.action) {
    payload.action = input.action
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

  const compactPayload: Record<string, unknown> = {
    capability: input.capability,
    event: input.event,
    mode: input.mode
  }

  if (input.reason) {
    compactPayload.reason = input.reason
  }

  if (typeof input.status === 'number') {
    compactPayload.status = input.status
  }

  if (input.claimId) {
    compactPayload.claimId = input.claimId
  }

  if (input.jobId) {
    compactPayload.jobId = input.jobId
  }

  if (input.stage) {
    compactPayload.stage = input.stage
  }

  if (input.action) {
    compactPayload.action = input.action
  }

  if (input.vin) {
    compactPayload.vin = input.vin
  }

  const shouldWarn = input.event === 'live_failure' || input.event === 'capability_unavailable'
  const failureCategory = shouldWarn
    ? classifyExternalFailure({
        status: input.status,
        reason: input.reason,
        errorMessage: input.details,
        fallbackCategory: input.event === 'capability_unavailable' ? 'unavailable' : 'unknown_error'
      })
    : null

  if (failureCategory) {
    compactPayload.failureCategory = failureCategory
  }

  const compactMessage = failureCategory
    ? `[provider_health] ${input.provider} ${failureCategory}`
    : `[provider_health] ${input.provider} ${status}`

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
