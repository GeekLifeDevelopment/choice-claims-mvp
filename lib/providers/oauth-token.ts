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

export async function getOAuthToken(config: OAuthTokenRequestConfig): Promise<OAuthTokenResponse | null> {
  if (!hasOAuthRequestConfig(config)) {
    return null
  }

  const cacheEntry = tokenCache.get(getCacheKey(config))
  if (cacheEntry && !isTokenExpired(cacheEntry.expiresAtEpochMs)) {
    return cacheEntry.token
  }

  const tokenUrl = normalizeNullable(config.tokenUrl)
  const username = normalizeNullable(config.username)
  const password = normalizeNullable(config.password)
  const clientId = normalizeNullable(config.clientId)
  const clientSecret = normalizeNullable(config.clientSecret)

  if (!tokenUrl || !username || !password || !clientId || !clientSecret) {
    return null
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

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })

  if (!response.ok) {
    return null
  }

  const json = (await response.json()) as Partial<OAuthTokenResponse>

  if (!json.access_token || !json.token_type || typeof json.expires_in !== 'number') {
    return null
  }

  return cacheToken(config, {
    access_token: json.access_token,
    token_type: json.token_type,
    expires_in: json.expires_in
  })
}
