import { getPcmiOAuthConfig } from '../config'
import { getPcmiAccessTokenResult } from './auth'

export type PcmiClientFailureCode =
  | 'not_configured'
  | 'auth_error'
  | 'request_failed'
  | 'request_timeout'
  | 'invalid_json'

export type PcmiProviderStatus = 'not_configured' | 'error' | 'ok'

export type PcmiClientSuccess<T> = {
  ok: true
  status: number
  data: T
}

export type PcmiClientFailure = {
  ok: false
  status?: number
  code: PcmiClientFailureCode
  providerStatus: PcmiProviderStatus
  message: string
}

export type PcmiClientResult<T> = PcmiClientSuccess<T> | PcmiClientFailure

export type PcmiRequestOptions = {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

function logInfo(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.info(`[pcmi_client] ${message}`, details)
    return
  }

  console.info(`[pcmi_client] ${message}`)
}

function logWarn(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.warn(`[pcmi_client] ${message}`, details)
    return
  }

  console.warn(`[pcmi_client] ${message}`)
}

function normalizePath(path: string): string {
  if (!path) {
    return '/'
  }

  return path.startsWith('/') ? path : `/${path}`
}

function buildPcmiUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>
): string {
  const url = new URL(normalizePath(path), `${baseUrl}/`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        continue
      }

      url.searchParams.set(key, String(value))
    }
  }

  return url.toString()
}

async function sendPcmiRequest<T>(
  url: string,
  token: string,
  options: PcmiRequestOptions
): Promise<PcmiClientResult<T>> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : undefined

  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response

  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'unknown_error'
    const isTimeout = /aborted|timeout/i.test(errorMessage)

    logWarn('request failed before response', {
      method: options.method ?? 'GET',
      path: options.path,
      reason: isTimeout ? 'timeout' : 'network_error'
    })

    return {
      ok: false,
      code: isTimeout ? 'request_timeout' : 'request_failed',
      providerStatus: 'error',
      message: isTimeout ? 'PCMI request timed out.' : 'PCMI request failed before response.'
    }
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '')

    logWarn('request failed response', {
      method: options.method ?? 'GET',
      path: options.path,
      status: response.status
    })

    return {
      ok: false,
      status: response.status,
      code: 'request_failed',
      providerStatus: 'error',
      message: `PCMI request failed (${response.status}). ${details.slice(0, 200)}`
    }
  }

  const rawText = await response.text()
  const trimmed = rawText.trim()

  if (!trimmed) {
    return {
      ok: true,
      status: response.status,
      data: null as T
    }
  }

  try {
    const data = JSON.parse(trimmed) as T

    return {
      ok: true,
      status: response.status,
      data
    }
  } catch {
    logWarn('response parse failed', {
      method: options.method ?? 'GET',
      path: options.path,
      status: response.status
    })

    return {
      ok: false,
      status: response.status,
      code: 'invalid_json',
      providerStatus: 'error',
      message: 'PCMI response was not valid JSON.'
    }
  }
}

export async function pcmiRequest<T = unknown>(options: PcmiRequestOptions): Promise<PcmiClientResult<T>> {
  const config = getPcmiOAuthConfig()

  if (!config.baseUrl || !config.tokenUrl || !config.clientId || !config.clientSecret || !config.username || !config.password) {
    logWarn('request blocked not configured', {
      method: options.method ?? 'GET',
      path: options.path
    })

    return {
      ok: false,
      code: 'not_configured',
      providerStatus: 'not_configured',
      message: 'PCMI provider is not configured.'
    }
  }

  const url = buildPcmiUrl(config.baseUrl, options.path, options.query)
  const authResult = await getPcmiAccessTokenResult()

  if (!authResult.ok) {
    logWarn('auth failed', {
      method: options.method ?? 'GET',
      path: options.path,
      code: authResult.code,
      status: authResult.status
    })

    return {
      ok: false,
      status: authResult.status,
      code: authResult.code === 'not_configured' ? 'not_configured' : 'auth_error',
      providerStatus: authResult.code === 'not_configured' ? 'not_configured' : 'error',
      message: authResult.message
    }
  }

  let result = await sendPcmiRequest<T>(url, authResult.token.access_token, options)

  if (result.ok || result.status !== 401) {
    if (!result.ok) {
      return result
    }

    logInfo('request success', {
      method: options.method ?? 'GET',
      path: options.path,
      status: result.status,
      authSource: authResult.source
    })

    return result
  }

  logInfo('request unauthorized; attempting token refresh', {
    method: options.method ?? 'GET',
    path: options.path
  })

  const refreshResult = await getPcmiAccessTokenResult({ forceRefresh: true })
  if (!refreshResult.ok) {
    return {
      ok: false,
      status: refreshResult.status,
      code: refreshResult.code === 'not_configured' ? 'not_configured' : 'auth_error',
      providerStatus: refreshResult.code === 'not_configured' ? 'not_configured' : 'error',
      message: refreshResult.message
    }
  }

  result = await sendPcmiRequest<T>(url, refreshResult.token.access_token, options)
  if (result.ok) {
    logInfo('request success after refresh', {
      method: options.method ?? 'GET',
      path: options.path,
      status: result.status
    })
  }

  return result
}
