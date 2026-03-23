type JsonRecord = Record<string, unknown>

type ClaimAttachmentRecord = {
  filename: string
  mimeType?: string | null
}

export type ClaimReviewSnapshot = {
  claimId: string
  claimNumber: string
  status: string

  source?: string

  vin?: string

  customer?: {
    name?: string
    email?: string
    phone?: string
  }

  vehicle?: {
    vin?: string
    year?: number
    make?: string
    model?: string
    trim?: string
    bodyStyle?: string
  }

  provider?: {
    providerName?: string
    fetchedAt?: string
    eventCount?: number
    enrichmentSummary?: Record<string, unknown>
  }

  attachments?: {
    count: number
    hasPhotos: boolean
    hasDocuments: boolean
  }

  asyncStatus?: {
    attemptCount?: number
    lastError?: string | null
    lastFailedAt?: string | null
  }

  flags?: string[]
}

export type ClaimReviewSnapshotInput = {
  id: string
  claimNumber: string
  status: string
  source?: string | null
  vin?: string | null
  claimantName?: string | null
  claimantEmail?: string | null
  claimantPhone?: string | null
  vinDataResult?: unknown
  vinDataProvider?: string | null
  vinDataFetchedAt?: Date | string | null
  vinLookupAttemptCount?: number | null
  vinLookupLastError?: string | null
  vinLookupLastFailedAt?: Date | string | null
  attachments?: ClaimAttachmentRecord[] | null
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined
  }

  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined
}

function looksLikePhoto(attachment: ClaimAttachmentRecord): boolean {
  const mime = (attachment.mimeType || '').toLowerCase()
  const filename = attachment.filename.toLowerCase()

  return (
    mime.startsWith('image/') ||
    /\.(jpg|jpeg|png|webp|gif|heic|heif|bmp|tiff)$/i.test(filename)
  )
}

function looksLikeDocument(attachment: ClaimAttachmentRecord): boolean {
  const mime = (attachment.mimeType || '').toLowerCase()
  const filename = attachment.filename.toLowerCase()

  return (
    mime.includes('pdf') ||
    mime.includes('msword') ||
    mime.includes('officedocument') ||
    mime.startsWith('text/') ||
    /\.(pdf|doc|docx|txt|rtf|xls|xlsx|csv)$/i.test(filename)
  )
}

function pickEnrichmentSummary(result: JsonRecord): Record<string, unknown> | undefined {
  const enrichmentKeys = [
    'quickCheck',
    'ownershipHistory',
    'accident',
    'mileage',
    'recall',
    'valuation',
    'titleProblem',
    'titleBrand'
  ]

  const summary: Record<string, unknown> = {}

  for (const key of enrichmentKeys) {
    if (result[key] !== undefined) {
      summary[key] = result[key]
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined
}

// Usage example for future pipeline tickets:
// const snapshot = buildClaimReviewSnapshot(claim)
// rulesEngine(snapshot)
// aiSummary(snapshot)
export function buildClaimReviewSnapshot(claim: ClaimReviewSnapshotInput): ClaimReviewSnapshot {
  const providerResult = asRecord(claim.vinDataResult)

  const vehicleVin = readOptionalString(providerResult.vin) ?? readOptionalString(claim.vin)
  const vehicleYear = readOptionalNumber(providerResult.year)
  const vehicleMake = readOptionalString(providerResult.make)
  const vehicleModel = readOptionalString(providerResult.model)
  const vehicleTrim = readOptionalString(providerResult.trim)
  const vehicleBodyStyle = readOptionalString(providerResult.bodyStyle)

  const attachments = claim.attachments ?? []
  const attachmentsSummary = {
    count: attachments.length,
    hasPhotos: attachments.some(looksLikePhoto),
    hasDocuments: attachments.some(looksLikeDocument)
  }

  const providerSummary = pickEnrichmentSummary(providerResult)
  const providerName = readOptionalString(claim.vinDataProvider) ?? readOptionalString(providerResult.provider)

  const flags: string[] = []

  if (!vehicleVin) {
    flags.push('missing_vin')
  }

  if (!providerName) {
    flags.push('provider_unavailable')
  }

  if (claim.status === 'ProviderFailed') {
    flags.push('provider_failed')
  }

  if (claim.status === 'ReadyForAI') {
    flags.push('ready_for_ai')
  }

  if (claim.vinLookupLastError && /429|rate[_ ]limit/i.test(claim.vinLookupLastError)) {
    flags.push('provider_rate_limited')
  }

  return {
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    status: claim.status,
    source: readOptionalString(claim.source),
    vin: vehicleVin,
    customer: {
      name: readOptionalString(claim.claimantName),
      email: readOptionalString(claim.claimantEmail),
      phone: readOptionalString(claim.claimantPhone)
    },
    vehicle: {
      vin: vehicleVin,
      year: vehicleYear,
      make: vehicleMake,
      model: vehicleModel,
      trim: vehicleTrim,
      bodyStyle: vehicleBodyStyle
    },
    provider: {
      providerName,
      fetchedAt: toIsoString(claim.vinDataFetchedAt),
      eventCount: readOptionalNumber(providerResult.eventCount),
      enrichmentSummary: providerSummary
    },
    attachments: attachmentsSummary,
    asyncStatus: {
      attemptCount:
        typeof claim.vinLookupAttemptCount === 'number' && Number.isFinite(claim.vinLookupAttemptCount)
          ? claim.vinLookupAttemptCount
          : undefined,
      lastError: claim.vinLookupLastError ?? null,
      lastFailedAt: toIsoString(claim.vinLookupLastFailedAt) ?? null
    },
    flags: flags.length > 0 ? flags : undefined
  }
}
