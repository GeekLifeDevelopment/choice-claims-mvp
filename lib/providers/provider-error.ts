export type ProviderErrorCode =
  | 'missing_provider_config'
  | 'oauth_request_failed'
  | 'oauth_invalid_response'
  | 'gateway_request_failed'
  | 'provider_http_error'
  | 'provider_timeout'
  | 'provider_no_vehicle_data'
  | 'provider_invalid_response'

export type ProviderLookupErrorInput = {
  provider: 'autocheck'
  endpoint: 'vinspecifications'
  code: ProviderErrorCode
  message: string
  status?: number
  reason?: string
  details?: string
}

export class ProviderLookupError extends Error {
  readonly provider: 'autocheck'
  readonly endpoint: 'vinspecifications'
  readonly code: ProviderErrorCode
  readonly status?: number
  readonly reason?: string
  readonly details?: string

  constructor(input: ProviderLookupErrorInput) {
    super(input.message)
    this.name = 'ProviderLookupError'
    this.provider = input.provider
    this.endpoint = input.endpoint
    this.code = input.code
    this.status = input.status
    this.reason = input.reason
    this.details = input.details
  }
}

export function isProviderLookupError(error: unknown): error is ProviderLookupError {
  return error instanceof ProviderLookupError
}
