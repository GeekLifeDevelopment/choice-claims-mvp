import { getOAuthToken, type OAuthTokenRequestConfig } from './oauth-token'

export type FetchWithOAuthSuccess<T = unknown> = {
  ok: true
  status: number
  data: T
}

export type FetchWithOAuthFailure = {
  ok: false
  status?: number
  error: 'missing_oauth_config' | 'token_unavailable' | 'request_failed' | 'invalid_json'
  details?: string
}

export type FetchWithOAuthResult<T = unknown> = FetchWithOAuthSuccess<T> | FetchWithOAuthFailure

export async function fetchWithOAuth<T = unknown>(
  config: OAuthTokenRequestConfig,
  url: string,
  init?: RequestInit
): Promise<FetchWithOAuthResult<T>> {
  const token = await getOAuthToken(config)

  if (!config.tokenUrl || !config.username || !config.password || !config.clientId || !config.clientSecret) {
    return {
      ok: false,
      error: 'missing_oauth_config'
    }
  }

  if (!token) {
    return {
      ok: false,
      error: 'token_unavailable'
    }
  }

  const headers = new Headers(init?.headers ?? {})
  headers.set('Authorization', `Bearer ${token.access_token}`)

  const response = await fetch(url, {
    ...init,
    headers
  })

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: 'request_failed',
      details: response.statusText
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
