import { getPcmiOAuthConfig, getProviderTimeoutMs, hasPcmiOAuthConfig } from '../config'

export type PcmiOAuthToken = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
}

export type PcmiAuthFailureCode =
  | 'not_configured'
  | 'auth_request_failed'
  | 'auth_invalid_response'
  | 'auth_timeout'

export type PcmiAuthResult =
  | {
      ok: true
      token: PcmiOAuthToken
      source: 'cache' | 'refresh' | 'password'
    }
  | {
      ok: false
      code: PcmiAuthFailureCode
      status?: number
      message: string
    }

type CachedPcmiToken = {
  token: PcmiOAuthToken
  expiresAtEpochMs: number
}

type TokenGrantRequestInput = {
  grantType: 'password' | 'refresh_token'
  refreshToken?: string
}

const tokenCache = new Map<string, CachedPcmiToken>()
const EARLY_REFRESH_WINDOW_MS = 5_000

function logInfo(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.info(`[pcmi_auth] ${message}`, details)
    return
  }

  console.info(`[pcmi_auth] ${message}`)
}

function logWarn(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.warn(`[pcmi_auth] ${message}`, details)
    return
  }

  console.warn(`[pcmi_auth] ${message}`)
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getCacheKey(): string {
  const config = getPcmiOAuthConfig()

  return [
    normalizeNullable(config.tokenUrl),
    normalizeNullable(config.clientId),
    normalizeNullable(config.username)
  ].join('|')
}

function isTokenExpired(expiresAtEpochMs: number): boolean {
  return Date.now() >= expiresAtEpochMs - EARLY_REFRESH_WINDOW_MS
}

function parseTokenPayload(payload: unknown): PcmiOAuthToken | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>
  const accessToken = typeof record.access_token === 'string' ? record.access_token : null
  const tokenType = typeof record.token_type === 'string' ? record.token_type : null
  const expiresInRaw = Number(record.expires_in)
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : undefined

  if (!accessToken || !tokenType || !Number.isFinite(expiresInRaw) || expiresInRaw <= 0) {
    return null
  }

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: Math.floor(expiresInRaw),
    refresh_token: refreshToken
  }
}

function cacheToken(token: PcmiOAuthToken): PcmiOAuthToken {
  const expiresAtEpochMs = Date.now() + token.expires_in * 1_000

  tokenCache.set(getCacheKey(), {
    token,
    expiresAtEpochMs
  })

  return token
}

async function requestTokenWithGrant(input: TokenGrantRequestInput): Promise<PcmiAuthResult> {
  const config = getPcmiOAuthConfig()

  if (!hasPcmiOAuthConfig() || !config.tokenUrl) {
    logWarn('not configured')

    return {
      ok: false,
      code: 'not_configured',
      message: 'PCMI OAuth config is missing required values.'
    }
  }

  const timeoutMs = getProviderTimeoutMs()
  const body = new URLSearchParams({
    grant_type: input.grantType,
    client_id: config.clientId!,
    client_secret: config.clientSecret!
  })

  if (input.grantType === 'password') {
    body.set('username', config.username!)
    body.set('password', config.password!)
  } else {
    if (!input.refreshToken) {
      return {
        ok: false,
        code: 'auth_invalid_response',
        message: 'PCMI refresh token is missing.'
      }
    }

    body.set('refresh_token', input.refreshToken)
  }

  logInfo('token request', {
    grantType: input.grantType,
    tokenUrl: config.tokenUrl,
    timeoutMs
  })

  let response: Response

  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'unknown_error'
    const isTimeout = /aborted|timeout/i.test(errorMessage)

    logWarn('token request failed before response', {
      grantType: input.grantType,
      reason: isTimeout ? 'timeout' : 'network_error'
    })

    return {
      ok: false,
      code: isTimeout ? 'auth_timeout' : 'auth_request_failed',
      message: isTimeout ? `PCMI token request timed out after ${timeoutMs}ms.` : 'PCMI token request failed.'
    }
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '')

    logWarn('token request failed response', {
      grantType: input.grantType,
      status: response.status
    })

    return {
      ok: false,
      code: 'auth_request_failed',
      status: response.status,
      message: `PCMI token request failed (${response.status}). ${details.slice(0, 200)}`
    }
  }

  let payload: unknown

  try {
    payload = await response.json()
  } catch {
    logWarn('token response invalid json', {
      grantType: input.grantType,
      status: response.status
    })

    return {
      ok: false,
      code: 'auth_invalid_response',
      status: response.status,
      message: 'PCMI token response was not valid JSON.'
    }
  }

  const token = parseTokenPayload(payload)

  if (!token) {
    logWarn('token response missing required fields', {
      grantType: input.grantType,
      status: response.status
    })

    return {
      ok: false,
      code: 'auth_invalid_response',
      status: response.status,
      message: 'PCMI token response is missing required fields.'
    }
  }

  cacheToken(token)

  logInfo('token request success', {
    grantType: input.grantType,
    status: response.status,
    expiresInSeconds: token.expires_in
  })

  return {
    ok: true,
    token,
    source: input.grantType === 'password' ? 'password' : 'refresh'
  }
}

export function clearPcmiTokenCache(): void {
  tokenCache.clear()
}

export async function requestPcmiAccessToken(): Promise<PcmiAuthResult> {
  return requestTokenWithGrant({ grantType: 'password' })
}

export async function refreshPcmiAccessToken(refreshToken: string): Promise<PcmiAuthResult> {
  return requestTokenWithGrant({
    grantType: 'refresh_token',
    refreshToken
  })
}

export async function getPcmiAccessTokenResult(options?: { forceRefresh?: boolean }): Promise<PcmiAuthResult> {
  const cacheEntry = tokenCache.get(getCacheKey())

  if (!options?.forceRefresh && cacheEntry && !isTokenExpired(cacheEntry.expiresAtEpochMs)) {
    return {
      ok: true,
      token: cacheEntry.token,
      source: 'cache'
    }
  }

  if (cacheEntry?.token.refresh_token) {
    const refreshed = await refreshPcmiAccessToken(cacheEntry.token.refresh_token)

    if (refreshed.ok) {
      return refreshed
    }

    logWarn('refresh token flow failed; falling back to password grant', {
      code: refreshed.code,
      status: refreshed.status
    })
  }

  return requestPcmiAccessToken()
}
