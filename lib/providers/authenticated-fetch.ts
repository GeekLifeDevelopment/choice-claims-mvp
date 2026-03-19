import { getOAuthTokenResult, type OAuthTokenRequestConfig } from './oauth-token'

export type FetchWithOAuthSuccess<T = unknown> = {
  ok: true
  status: number
  data: T
}

export type FetchWithOAuthFailure = {
  ok: false
  status?: number
  error:
    | 'missing_oauth_config'
    | 'oauth_request_failed'
    | 'oauth_invalid_response'
    | 'provider_timeout'
    | 'request_failed'
    | 'invalid_json'
  details?: string
}

export type FetchWithOAuthResult<T = unknown> = FetchWithOAuthSuccess<T> | FetchWithOAuthFailure

export async function fetchWithOAuth<T = unknown>(
  config: OAuthTokenRequestConfig,
  url: string,
  init?: RequestInit
): Promise<FetchWithOAuthResult<T>> {
  const tokenResult = await getOAuthTokenResult(config)

  if (!tokenResult.ok) {
    return {
      ok: false,
      status: tokenResult.status,
      error: tokenResult.code,
      details: tokenResult.details
    }
  }

  const headers = new Headers(init?.headers ?? {})
  headers.set('Authorization', `Bearer ${tokenResult.token.access_token}`)

  let response: Response

  try {
    response = await fetch(url, {
      ...init,
      headers
    })
  } catch (error) {
    const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message)

    return {
      ok: false,
      error: isTimeout ? 'provider_timeout' : 'request_failed',
      details: isTimeout ? 'Provider request timed out' : 'Provider request failed before response'
    }
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => '')
    const bodyPreview = responseText.trim().slice(0, 300)

    return {
      ok: false,
      status: response.status,
      error: 'request_failed',
      details: bodyPreview || response.statusText
    }
  }

  try {
    const data = (await response.json()) as T

    return {
      ok: true,
      status: response.status,
      data
    }
  } catch {
    return {
      ok: false,
      status: response.status,
      error: 'invalid_json'
    }
  }
}
