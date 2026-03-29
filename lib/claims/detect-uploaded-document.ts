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

function normalizeToken(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
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
