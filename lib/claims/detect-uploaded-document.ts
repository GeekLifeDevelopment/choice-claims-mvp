import { readPdfTextConservatively } from './read-pdf-text'

export type DetectedDocumentType = 'carfax' | 'autocheck' | 'choice_contract' | 'unknown'
export type DocumentMatchStatus = 'matched' | 'possible_match' | 'conflict' | 'no_match' | 'pending'

type DetectionInput = {
  fileName: string
  pdfBytes: Buffer
  claimVin?: string | null
  claimantName?: string | null
}

export type DocumentAnchorData = {
  vin: string | null
  claimantName: string | null
  mileage: number | null
  contractDate: string | null
  purchaseDate: string | null
  agreementDate: string | null
}

export type DocumentDetectionResult = {
  documentType: DetectedDocumentType
  matchStatus: DocumentMatchStatus
  matchNotes: string
  anchors: DocumentAnchorData
  processingStatus: 'classified' | 'pending'
}

export type ChoicePostExtractionMatchResolution = {
  matchStatus: DocumentMatchStatus
  matchNotes: string
  processingStatus: 'classified' | 'pending'
  anchors: DocumentAnchorData
  resolutionReason:
    | 'exact_vin_match'
    | 'vin_conflict'
    | 'partial_contract_anchor_match'
    | 'insufficient_contract_anchors'
    | 'reclassified_choice_without_extraction'
    | 'unchanged'
  usedFallbackAnchors: boolean
  availableAnchors: {
    vin: boolean
    agreementNumber: boolean
    mileageAtSale: boolean
    vehiclePurchaseDate: boolean
    agreementPurchaseDate: boolean
    claimantName: boolean
  }
}

function normalizeToken(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function normalizeVin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
  if (normalized.length !== 17) {
    return null
  }

  return normalized
}

function normalizeAgreementNumber(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toUpperCase()
  return normalized.length > 0 ? normalized : null
}

function normalizeMileage(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }

  if (typeof value === 'string') {
    const numeric = Number.parseInt(value.replace(/[\s,]/g, ''), 10)
    if (Number.isFinite(numeric)) {
      return Math.max(0, numeric)
    }
  }

  return null
}

function normalizeComparableDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const isoMatch = trimmed.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/)
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1], 10)
    const month = Number.parseInt(isoMatch[2], 10)
    const day = Number.parseInt(isoMatch[3], 10)
    if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  const usMatch = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/)
  if (!usMatch) {
    return null
  }

  const month = Number.parseInt(usMatch[1], 10)
  const day = Number.parseInt(usMatch[2], 10)
  const yearRaw = Number.parseInt(usMatch[3], 10)
  const year = usMatch[3].length === 2 ? 2000 + yearRaw : yearRaw
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) {
    return null
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

async function extractPdfText(pdfBytes: Buffer): Promise<{ text: string; parseFailed: boolean }> {
  return readPdfTextConservatively(pdfBytes)
}

function detectType(text: string): DetectedDocumentType {
  const upper = text.toUpperCase()

  if (upper.includes('CARFAX')) {
    return 'carfax'
  }

  if (upper.includes('AUTOCHECK') || upper.includes('EXPERIAN AUTOMOTIVE')) {
    return 'autocheck'
  }

  const choiceContractMarkers = [
    'CHOICE AUTO PROTECTION',
    'VEHICLE SERVICE CONTRACT',
    'SERVICE CONTRACT',
    'DECLARATIONS',
    'CONTRACT PURCHASE DATE',
    'AGREEMENT NUMBER',
    'AGREEMENT NO',
    'DEDUCTIBLE',
    'COVERAGE LEVEL'
  ]
  const choiceMarkerCount = choiceContractMarkers.filter((marker) => upper.includes(marker)).length

  if (
    upper.includes('CHOICE AUTO PROTECTION') ||
    (upper.includes('VEHICLE SERVICE CONTRACT') && upper.includes('CHOICE')) ||
    (upper.includes('DECLARATIONS') && upper.includes('CHOICE AUTO')) ||
    (upper.includes('CHOICE') && choiceMarkerCount >= 2)
  ) {
    return 'choice_contract'
  }

  return 'unknown'
}

function extractFirstVin(text: string): string | null {
  const upper = text.toUpperCase()
  const matches = upper.match(/\b[A-HJ-NPR-Z0-9]{17}\b/g)
  if (!matches || matches.length === 0) {
    return null
  }

  return matches[0]
}

function extractMileage(text: string): number | null {
  const match = text.match(/(?:odometer|mileage)[^\d]{0,25}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i)
  if (!match || !match[1]) {
    return null
  }

  const value = Number.parseInt(match[1].replace(/,/g, ''), 10)
  return Number.isFinite(value) ? value : null
}

function extractLikelyDates(text: string): string[] {
  const matches = Array.from(text.matchAll(/\b(?:0?[1-9]|1[0-2])[\/.-](?:0?[1-9]|[12]\d|3[01])[\/.-](?:\d{2}|\d{4})\b/g))
    .map((entry) => entry[0])
    .slice(0, 3)

  return matches
}

function buildAnchors(input: {
  text: string
  claimantName?: string | null
}): DocumentAnchorData {
  const vin = extractFirstVin(input.text)
  const mileage = extractMileage(input.text)
  const dates = extractLikelyDates(input.text)
  const normalizedText = normalizeToken(input.text)

  const claimantName =
    input.claimantName && normalizeToken(input.claimantName).length > 0
      ? normalizedText.includes(normalizeToken(input.claimantName))
        ? input.claimantName
        : null
      : null

  return {
    vin,
    claimantName,
    mileage,
    contractDate: dates[0] ?? null,
    purchaseDate: dates[1] ?? null,
    agreementDate: dates[2] ?? null
  }
}

function hasAnyAnchor(anchors: DocumentAnchorData): boolean {
  return Boolean(
    anchors.vin ||
      anchors.claimantName ||
      anchors.mileage !== null ||
      anchors.contractDate ||
      anchors.purchaseDate ||
      anchors.agreementDate
  )
}

function matchDocument(input: {
  anchors: DocumentAnchorData
  documentType: DetectedDocumentType
  claimVin?: string | null
  parseFailed: boolean
}): Pick<DocumentDetectionResult, 'matchStatus' | 'matchNotes' | 'processingStatus'> {
  const normalizedClaimVin = input.claimVin ? input.claimVin.trim().toUpperCase() : null
  const normalizedDocVin = input.anchors.vin ? input.anchors.vin.trim().toUpperCase() : null

  if (normalizedClaimVin && normalizedDocVin) {
    if (normalizedClaimVin === normalizedDocVin) {
      return {
        matchStatus: 'matched',
        matchNotes: 'VIN matches claim VIN exactly.',
        processingStatus: 'classified'
      }
    }

    return {
      matchStatus: 'conflict',
      matchNotes: `VIN mismatch: document VIN ${normalizedDocVin} differs from claim VIN ${normalizedClaimVin}.`,
      processingStatus: 'classified'
    }
  }

  if (!hasAnyAnchor(input.anchors)) {
    return {
      matchStatus: 'pending',
      matchNotes: input.parseFailed
        ? 'Unable to parse document text confidently. Classification pending.'
        : 'No reliable anchors detected for match verification.',
      processingStatus: 'pending'
    }
  }

  if (input.anchors.claimantName) {
    return {
      matchStatus: 'possible_match',
      matchNotes: 'Claimant name marker found but VIN was not reliably detected.',
      processingStatus: 'classified'
    }
  }

  if (input.documentType !== 'unknown') {
    return {
      matchStatus: 'possible_match',
      matchNotes: 'Document type detected, but anchors are insufficient for a full match.',
      processingStatus: 'classified'
    }
  }

  return {
    matchStatus: 'no_match',
    matchNotes: 'Document appears unrelated to this claim based on available anchors.',
    processingStatus: 'classified'
  }
}

function getRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

export function resolveChoiceMatchAfterExtraction(input: {
  initial: Pick<DocumentDetectionResult, 'matchStatus' | 'matchNotes' | 'processingStatus' | 'anchors'>
  extractionStatus: 'pending' | 'extracted' | 'partial' | 'failed' | 'skipped'
  extractedData: Record<string, unknown> | null
  claimVin?: string | null
}): ChoicePostExtractionMatchResolution {
  const extracted = getRecord(input.extractedData)
  const fallback = getRecord(extracted.__choiceContractFallback)
  const usedFallbackAnchors = fallback.used === true

  const claimVin = normalizeVin(input.claimVin)
  const extractedVin = normalizeVin(extracted.vin)
  const agreementNumber = normalizeAgreementNumber(extracted.agreementNumber)
  const mileageAtSale = normalizeMileage(extracted.mileageAtSale)
  const vehiclePurchaseDate = normalizeComparableDate(extracted.vehiclePurchaseDate)
  const agreementPurchaseDate = normalizeComparableDate(extracted.agreementPurchaseDate)

  const anchors: DocumentAnchorData = {
    vin: extractedVin ?? input.initial.anchors.vin,
    claimantName: input.initial.anchors.claimantName,
    mileage: mileageAtSale ?? input.initial.anchors.mileage,
    contractDate: input.initial.anchors.contractDate,
    purchaseDate: vehiclePurchaseDate ?? input.initial.anchors.purchaseDate,
    agreementDate: agreementPurchaseDate ?? input.initial.anchors.agreementDate
  }

  const availableAnchors = {
    vin: Boolean(extractedVin),
    agreementNumber: Boolean(agreementNumber),
    mileageAtSale: mileageAtSale !== null,
    vehiclePurchaseDate: Boolean(vehiclePurchaseDate),
    agreementPurchaseDate: Boolean(agreementPurchaseDate),
    claimantName: Boolean(anchors.claimantName)
  }

  const nonVinAnchorCount = [
    availableAnchors.agreementNumber,
    availableAnchors.mileageAtSale,
    availableAnchors.vehiclePurchaseDate,
    availableAnchors.agreementPurchaseDate,
    availableAnchors.claimantName
  ].filter(Boolean).length

  const noUsableExtractionAnchors = !availableAnchors.vin && nonVinAnchorCount === 0

  console.info('[choice_match_resolution] evaluating post-extraction match', {
    initialMatchStatus: input.initial.matchStatus,
    extractionStatus: input.extractionStatus,
    claimVin,
    extractedVin,
    agreementNumber,
    mileageAtSale,
    vehiclePurchaseDate,
    agreementPurchaseDate,
    usedFallbackAnchors,
    availableAnchors,
    nonVinAnchorCount,
    noUsableExtractionAnchors
  })

  if (input.extractionStatus !== 'extracted' && input.extractionStatus !== 'partial') {
    if (input.initial.matchStatus === 'no_match') {
      const reclassifiedWithoutExtractionResult: ChoicePostExtractionMatchResolution = {
        matchStatus: 'pending',
        matchNotes:
          'Choice contract was detected, but extraction did not produce reliable anchors for match verification.',
        processingStatus: 'pending',
        anchors,
        resolutionReason: 'reclassified_choice_without_extraction',
        usedFallbackAnchors,
        availableAnchors
      }

      console.info('[choice_match_resolution] completed post-extraction match', {
        resolutionReason: reclassifiedWithoutExtractionResult.resolutionReason,
        finalMatchStatus: reclassifiedWithoutExtractionResult.matchStatus
      })

      return reclassifiedWithoutExtractionResult
    }

    const unchangedResult: ChoicePostExtractionMatchResolution = {
      matchStatus: input.initial.matchStatus,
      matchNotes: input.initial.matchNotes,
      processingStatus: input.initial.processingStatus,
      anchors,
      resolutionReason: 'unchanged',
      usedFallbackAnchors,
      availableAnchors
    }

    console.info('[choice_match_resolution] completed post-extraction match', {
      resolutionReason: unchangedResult.resolutionReason,
      finalMatchStatus: unchangedResult.matchStatus
    })

    return unchangedResult
  }

  if (claimVin && extractedVin) {
    if (claimVin === extractedVin) {
      const vinMatchResult: ChoicePostExtractionMatchResolution = {
        matchStatus: 'matched',
        matchNotes: usedFallbackAnchors
          ? 'VIN matches claim VIN after Choice extraction fallback.'
          : 'VIN matches claim VIN after Choice extraction.',
        processingStatus: 'classified',
        anchors,
        resolutionReason: 'exact_vin_match',
        usedFallbackAnchors,
        availableAnchors
      }

      console.info('[choice_match_resolution] completed post-extraction match', {
        resolutionReason: vinMatchResult.resolutionReason,
        finalMatchStatus: vinMatchResult.matchStatus
      })

      return vinMatchResult
    }

    const vinConflictResult: ChoicePostExtractionMatchResolution = {
      matchStatus: 'conflict',
      matchNotes: `VIN mismatch after Choice extraction: document VIN ${extractedVin} differs from claim VIN ${claimVin}.`,
      processingStatus: 'classified',
      anchors,
      resolutionReason: 'vin_conflict',
      usedFallbackAnchors,
      availableAnchors
    }

    console.info('[choice_match_resolution] completed post-extraction match', {
      resolutionReason: vinConflictResult.resolutionReason,
      finalMatchStatus: vinConflictResult.matchStatus
    })

    return vinConflictResult
  }

  if (noUsableExtractionAnchors) {
    const insufficientAnchorsResult: ChoicePostExtractionMatchResolution = {
      matchStatus: 'pending',
      matchNotes: 'Choice extraction completed but no reliable anchors were available for match verification.',
      processingStatus: 'pending',
      anchors,
      resolutionReason: 'insufficient_contract_anchors',
      usedFallbackAnchors,
      availableAnchors
    }

    console.info('[choice_match_resolution] completed post-extraction match', {
      resolutionReason: insufficientAnchorsResult.resolutionReason,
      finalMatchStatus: insufficientAnchorsResult.matchStatus
    })

    return insufficientAnchorsResult
  }

  const partialAnchorResult: ChoicePostExtractionMatchResolution = {
    matchStatus: 'possible_match',
    matchNotes: usedFallbackAnchors
      ? 'Choice extraction fallback produced usable anchors, but VIN was not confirmed.'
      : 'Choice extraction produced usable anchors, but VIN was not confirmed.',
    processingStatus: 'classified',
    anchors,
    resolutionReason: 'partial_contract_anchor_match',
    usedFallbackAnchors,
    availableAnchors
  }

  console.info('[choice_match_resolution] completed post-extraction match', {
    resolutionReason: partialAnchorResult.resolutionReason,
    finalMatchStatus: partialAnchorResult.matchStatus
  })

  return partialAnchorResult
}

export async function detectAndMatchUploadedDocument(input: DetectionInput): Promise<DocumentDetectionResult> {
  const parsed = await extractPdfText(input.pdfBytes)
  const documentType = detectType(parsed.text)
  const anchors = buildAnchors({
    text: parsed.text,
    claimantName: input.claimantName
  })
  const matched = matchDocument({
    anchors,
    documentType,
    claimVin: input.claimVin,
    parseFailed: parsed.parseFailed
  })

  return {
    documentType,
    matchStatus: matched.matchStatus,
    matchNotes: matched.matchNotes,
    anchors,
    processingStatus: matched.processingStatus
  }
}
