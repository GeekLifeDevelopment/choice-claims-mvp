type OAuthTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
}

export type OAuthTokenRequestConfig = {
  tokenUrl: string | null
  username: string | null
  password: string | null
  clientId: string | null
  clientSecret: string | null
  scope?: string | null
  cacheKey?: string
  requestTimeoutMs?: number
}

export type OAuthTokenFailureCode =
  | 'missing_oauth_config'
  | 'oauth_request_failed'
  | 'oauth_invalid_response'
  | 'provider_timeout'

export type OAuthTokenResult =
  | {
      ok: true
      token: OAuthTokenResponse
    }
  | {
      ok: false
      code: OAuthTokenFailureCode
      status?: number
      details?: string
    }

type CachedOAuthToken = {
  token: OAuthTokenResponse
  expiresAtEpochMs: number
}

const tokenCache = new Map<string, CachedOAuthToken>()

function normalizeNullable(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function getCacheKey(config: OAuthTokenRequestConfig): string {
  if (config.cacheKey) {
    return config.cacheKey
  }

  return [
    normalizeNullable(config.tokenUrl),
    normalizeNullable(config.clientId),
    normalizeNullable(config.username)
  ].join('|')
}

function hasOAuthRequestConfig(config: OAuthTokenRequestConfig): boolean {
  return Boolean(
    normalizeNullable(config.tokenUrl) &&
      normalizeNullable(config.username) &&
      normalizeNullable(config.password) &&
      normalizeNullable(config.clientId) &&
      normalizeNullable(config.clientSecret)
  )
}

export function isTokenExpired(expiresAtEpochMs: number): boolean {
  const now = Date.now()
  // Refresh a little early to reduce edge expirations in flight.
  return now >= expiresAtEpochMs - 5_000
}

export function cacheToken(config: OAuthTokenRequestConfig, token: OAuthTokenResponse): OAuthTokenResponse {
  const expiresInSeconds = Number(token.expires_in)
  const safeExpiresInSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 60
  const expiresAtEpochMs = Date.now() + safeExpiresInSeconds * 1_000

  tokenCache.set(getCacheKey(config), {
    token,
    expiresAtEpochMs
  })

  return token
}

export async function getOAuthTokenResult(config: OAuthTokenRequestConfig): Promise<OAuthTokenResult> {
  if (!hasOAuthRequestConfig(config)) {
    return {
      ok: false,
      code: 'missing_oauth_config'
    }
  }

  const cacheEntry = tokenCache.get(getCacheKey(config))
  if (cacheEntry && !isTokenExpired(cacheEntry.expiresAtEpochMs)) {
    return {
      ok: true,
      token: cacheEntry.token
    }
  }

  const tokenUrl = normalizeNullable(config.tokenUrl)
  const username = normalizeNullable(config.username)
  const password = normalizeNullable(config.password)
  const clientId = normalizeNullable(config.clientId)
  const clientSecret = normalizeNullable(config.clientSecret)

  if (!tokenUrl || !username || !password || !clientId || !clientSecret) {
    return {
      ok: false,
      code: 'missing_oauth_config'
    }
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_id: clientId,
    client_secret: clientSecret
  })

  const scope = normalizeNullable(config.scope)
  if (scope) {
    body.set('scope', scope)
  }

  const timeoutMs =
    typeof config.requestTimeoutMs === 'number' && Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
      ? Math.floor(config.requestTimeoutMs)
      : null

  let response: Response

  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    })
  } catch (error) {
    const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message)

    return {
      ok: false,
      code: isTimeout ? 'provider_timeout' : 'oauth_request_failed',
      details: isTimeout ? `OAuth token request timed out after ${timeoutMs ?? 0}ms` : 'OAuth token request failed'
    }
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => '')

    return {
      ok: false,
      code: 'oauth_request_failed',
      status: response.status,
      details: responseText.trim().slice(0, 300) || response.statusText
    }
  }

  let json: Partial<OAuthTokenResponse>

  try {
    json = (await response.json()) as Partial<OAuthTokenResponse>
  } catch {
    return {
      ok: false,
      code: 'oauth_invalid_response',
      status: response.status,
      details: 'OAuth token response was not valid JSON'
    }
  }

  const parsedExpiresIn = Number(json.expires_in)

  if (!json.access_token || !json.token_type || !Number.isFinite(parsedExpiresIn) || parsedExpiresIn <= 0) {
    return {
      ok: false,
      code: 'oauth_invalid_response',
      status: response.status,
      details: 'OAuth token response missing required fields'
    }
  }

  const token = cacheToken(config, {
    access_token: json.access_token,
    token_type: json.token_type,
    expires_in: parsedExpiresIn
  })

  return {
    ok: true,
    token
  }
}

export async function getOAuthToken(config: OAuthTokenRequestConfig): Promise<OAuthTokenResponse | null> {
  const result = await getOAuthTokenResult(config)
  return result.ok ? result.token : null
}
