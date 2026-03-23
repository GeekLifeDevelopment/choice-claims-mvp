import { getProviderTimeoutMs, getVinSpecFallbackBaseUrl } from './config'
import { logProviderHealth } from './provider-health-log'
import type { VinSpecFallbackResult } from './types'

type VinSpecFallbackApiResponse = {
  Results?: unknown[]
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

function getOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function buildFallbackApiUrl(vin: string): string {
  const baseUrl = getVinSpecFallbackBaseUrl().replace(/\/+$/, '')
  const url = new URL(`/DecodeVinValuesExtended/${encodeURIComponent(vin)}`, `${baseUrl}/`)
  url.searchParams.set('format', 'json')
  return url.toString()
}

function buildFallbackResult(value: unknown): VinSpecFallbackResult | null {
  const record = asRecord(value)

  const result: VinSpecFallbackResult = {
    source: 'nhtsa_vpic',
    fetchedAt: new Date().toISOString(),
    year: getOptionalNumber(record.ModelYear),
    make: getOptionalString(record.Make),
    model: getOptionalString(record.Model),
    trim: getOptionalString(record.Trim),
    bodyStyle: getOptionalString(record.BodyClass),
    drivetrain: getOptionalString(record.DriveType),
    transmissionType: getOptionalString(record.TransmissionStyle),
    engineSize: getOptionalString(record.EngineModel) || getOptionalString(record.DisplacementL),
    cylinders: getOptionalString(record.EngineCylinders),
    fuelType: getOptionalString(record.FuelTypePrimary),
    manufacturer: getOptionalString(record.Manufacturer)
  }

  const hasUsefulSpecs = Boolean(result.year || result.make || result.model || result.trim)
  return hasUsefulSpecs ? result : null
}

export class VinSpecFallbackProvider {
  readonly name = 'nhtsa_vpic' as const

  async lookupVinSpecs(vin: string): Promise<VinSpecFallbackResult | null> {
    logProviderHealth({
      provider: this.name,
      capability: 'vin_spec_fallback',
      event: 'configured',
      mode: 'live',
      vin,
      source: 'nhtsa_vpic'
    })

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(buildFallbackApiUrl(vin), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_spec_fallback',
          event: 'live_failure',
          mode: 'failed',
          vin,
          status: response.status,
          reason: 'http_error'
        })

        throw new Error(`VIN spec fallback request failed (${response.status})`)
      }

      const payload = (await response.json()) as VinSpecFallbackApiResponse
      const firstResult = Array.isArray(payload.Results) ? payload.Results[0] : null
      const result = buildFallbackResult(firstResult)

      if (!result) {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_spec_fallback',
          event: 'capability_unavailable',
          mode: 'unavailable',
          vin,
          reason: 'no_useful_specs'
        })
      } else {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_spec_fallback',
          event: 'live_success',
          mode: 'live',
          vin,
          source: result.source
        })
      }

      return result
    } catch (error) {
      if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_spec_fallback',
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
