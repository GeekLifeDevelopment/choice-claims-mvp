import { getNhtsaRecallsBaseUrl, getProviderTimeoutMs } from './config'
import { logProviderHealth } from './provider-health-log'
import type { NhtsaRecallItem, NhtsaRecallsResult } from './types'

type NhtsaRecallsApiResponse = {
  Count?: number
  Message?: string
  Results?: unknown[]
  results?: unknown[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function toRecallItem(value: unknown): NhtsaRecallItem | null {
  const record = asRecord(value)
  const campaignId = getOptionalString(record.NHTSACampaignNumber)
  const component = getOptionalString(record.Component)
  const summary = getOptionalString(record.Summary)
  const remedy = getOptionalString(record.Remedy)
  const safetyRisk = getOptionalString(record.Conequence) || getOptionalString(record.Consequence)
  const reportDate = getOptionalString(record.ReportReceivedDate)

  if (!campaignId && !component && !summary && !remedy && !safetyRisk && !reportDate) {
    return null
  }

  return {
    campaignId,
    component,
    summary,
    remedy,
    safetyRisk,
    reportDate
  }
}

function buildRecallsApiUrl(vin: string): string {
  const baseUrl = getNhtsaRecallsBaseUrl().replace(/\/+$/, '')
  const url = new URL('/recalls/recallsByVehicle', `${baseUrl}/`)
  url.searchParams.set('vin', vin)
  return url.toString()
}

function getResultsArray(payload: NhtsaRecallsApiResponse): unknown[] {
  if (Array.isArray(payload.Results)) {
    return payload.Results
  }

  if (Array.isArray(payload.results)) {
    return payload.results
  }

  return []
}

function isSuccessLikePayload(payload: NhtsaRecallsApiResponse): boolean {
  const message = getOptionalString(payload.Message)?.toLowerCase()
  const hasCount = typeof payload.Count === 'number' && Number.isFinite(payload.Count)
  const hasResults = Array.isArray(payload.Results) || Array.isArray(payload.results)

  return (message?.includes('results returned successfully') ?? false) || hasCount || hasResults
}

export class NhtsaRecallsProvider {
  readonly name = 'nhtsa' as const

  async lookupRecalls(vin: string): Promise<NhtsaRecallsResult> {
    logProviderHealth({
      provider: this.name,
      capability: 'recalls',
      event: 'configured',
      mode: 'live',
      vin,
      source: 'nhtsa'
    })

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(buildRecallsApiUrl(vin), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      })

      const payload = (await response.json()) as NhtsaRecallsApiResponse

      if (!response.ok && !isSuccessLikePayload(payload)) {
        logProviderHealth({
          provider: this.name,
          capability: 'recalls',
          event: 'live_failure',
          mode: 'failed',
          vin,
          status: response.status,
          reason: 'http_error'
        })

        throw new Error(`NHTSA recalls request failed (${response.status})`)
      }

      const items = getResultsArray(payload)
        .map(toRecallItem)
        .filter((item): item is NhtsaRecallItem => Boolean(item))

      const count = typeof payload.Count === 'number' && Number.isFinite(payload.Count)
        ? payload.Count
        : items.length

      const result = {
        source: this.name,
        fetchedAt: new Date().toISOString(),
        count,
        message: getOptionalString(payload.Message),
        items
      }

      logProviderHealth({
        provider: this.name,
        capability: 'recalls',
        event: 'live_success',
        mode: 'live',
        vin,
        source: result.source
      })

      return result
    } catch (error) {
      if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
        logProviderHealth({
          provider: this.name,
          capability: 'recalls',
          event: 'live_failure',
          mode: 'failed',
          vin,
          reason: 'provider_timeout'
        })
      }

      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
