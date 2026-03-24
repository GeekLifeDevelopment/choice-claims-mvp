export type ExternalFailureCategory =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_response'
  | 'auth_error'
  | 'network_error'
  | 'unknown_error'

type ClassifyExternalFailureInput = {
  status?: number
  reason?: string | null
  errorMessage?: string | null
  fallbackCategory?: ExternalFailureCategory
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function classifyByStatus(status: number | undefined): ExternalFailureCategory | null {
  if (status === 429) {
    return 'rate_limited'
  }

  if (status === 408) {
    return 'timeout'
  }

  if (status === 401 || status === 403) {
    return 'auth_error'
  }

  if (typeof status === 'number' && status >= 500) {
    return 'unavailable'
  }

  if (typeof status === 'number' && status >= 400) {
    return 'bad_response'
  }

  return null
}

function classifyByText(text: string): ExternalFailureCategory | null {
  if (!text) {
    return null
  }

  if (includesAny(text, ['timeout', 'timed out', 'abort', 'aborted'])) {
    return 'timeout'
  }

  if (includesAny(text, ['429', 'rate_limited', 'rate limit'])) {
    return 'rate_limited'
  }

  if (includesAny(text, ['401', '403', 'unauthorized', 'forbidden', 'oauth'])) {
    return 'auth_error'
  }

  if (includesAny(text, ['invalid_json', 'invalid response', 'invalid_response', 'unexpected_payload', 'bad_request'])) {
    return 'bad_response'
  }

  if (
    includesAny(text, [
      'network',
      'request_exception',
      'request_failed',
      'gateway_request_failed',
      'failed before response',
      'fetch failed',
      'econnreset',
      'enotfound',
      'eai_again'
    ])
  ) {
    return 'network_error'
  }

  if (includesAny(text, ['unavailable', '5xx', 'server_error', 'capacity', 'capability_unavailable'])) {
    return 'unavailable'
  }

  return null
}

export function classifyExternalFailure(input: ClassifyExternalFailureInput): ExternalFailureCategory {
  const statusCategory = classifyByStatus(input.status)
  if (statusCategory) {
    return statusCategory
  }

  const reasonCategory = classifyByText(normalize(input.reason))
  if (reasonCategory) {
    return reasonCategory
  }

  const messageCategory = classifyByText(normalize(input.errorMessage))
  if (messageCategory) {
    return messageCategory
  }

  if (input.fallbackCategory) {
    return input.fallbackCategory
  }

  return 'unknown_error'
}