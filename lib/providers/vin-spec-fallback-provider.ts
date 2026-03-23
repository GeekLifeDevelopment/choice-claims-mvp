import { getProviderTimeoutMs } from './config'
import type { VinSpecFallbackResult } from './types'

const DEFAULT_VIN_SPEC_FALLBACK_BASE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles'

type VinSpecFallbackApiResponse = {
  Results?: unknown[]
}

function getVinSpecFallbackBaseUrl(): string {
  const configured = process.env.VIN_SPEC_FALLBACK_API_URL?.trim()
  return configured || DEFAULT_VIN_SPEC_FALLBACK_BASE_URL
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
        throw new Error(`VIN spec fallback request failed (${response.status})`)
      }

      const payload = (await response.json()) as VinSpecFallbackApiResponse
      const firstResult = Array.isArray(payload.Results) ? payload.Results[0] : null
      return buildFallbackResult(firstResult)
    } finally {
      clearTimeout(timeout)
    }
  }
}
