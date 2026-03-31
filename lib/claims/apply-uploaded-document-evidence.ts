import type { DetectedDocumentType, DocumentMatchStatus } from './detect-uploaded-document'

export type EvidenceApplyStatus = 'pending' | 'applied' | 'partial' | 'conflict' | 'skipped'

type ApplyInput = {
  documentId: string
  source?: 'uploaded_document' | 'cognito_form'
  documentType: DetectedDocumentType
  matchStatus: DocumentMatchStatus
  extractionStatus: 'pending' | 'extracted' | 'partial' | 'failed' | 'skipped'
  extractedData: Record<string, unknown> | null
  vinDataResult: unknown
}

type CandidateField = {
  sourceField: string
  targetPath: string
  value: string | number | boolean
}

type FieldConflict = {
  field: string
  existing: string | number | boolean
  incoming: string | number | boolean
  reason: string
}

type AppliedFieldDetail = {
  field: string
  value: string | number | boolean
  source: 'uploaded_document' | 'cognito_form'
  sourceDocumentId: string
  sourceDocumentType: DetectedDocumentType
  appliedAt: string
}

export type EvidenceApplyResult = {
  applyStatus: EvidenceApplyStatus
  appliedFields: string[]
  skippedFields: string[]
  conflictFields: FieldConflict[]
  appliedFieldDetails: AppliedFieldDetail[]
  appliedAt: string
  nextVinDataResult: Record<string, unknown>
  didMutateClaimEvidence: boolean
}

const SUPPORTED_TYPES = new Set<DetectedDocumentType>(['carfax', 'autocheck', 'choice_contract'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
    : {}
}

function normalizeDate(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    return value.trim()
  }

  return parsed.toISOString().slice(0, 10)
}

function parseComparableDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return normalizeDate(value)
}

function valuesEqual(field: string, existing: unknown, incoming: unknown): boolean {
  if (typeof existing === 'number' && typeof incoming === 'number') {
    if (field.includes('mileage')) {
      return Math.abs(existing - incoming) <= 100
    }

    return existing === incoming
  }

  if (typeof existing === 'boolean' && typeof incoming === 'boolean') {
    return existing === incoming
  }

  if (typeof existing === 'string' && typeof incoming === 'string') {
    const maybeDateExisting = parseComparableDate(existing)
    const maybeDateIncoming = parseComparableDate(incoming)
    if (maybeDateExisting && maybeDateIncoming) {
      return maybeDateExisting === maybeDateIncoming
    }

    return existing.trim().toLowerCase() === incoming.trim().toLowerCase()
  }

  return false
}

function getValueAtPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cursor: unknown = root

  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined
    }

    cursor = (cursor as Record<string, unknown>)[part]
  }

  return cursor
}

function setValueAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = root

  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {}
    }

    cursor = cursor[key] as Record<string, unknown>
  }

  const finalKey = parts[parts.length - 1]
  cursor[finalKey] = value
}

function hasMeaningfulValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (typeof value === 'boolean') {
    return true
  }

  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  return false
}

function buildFieldCandidates(input: {
  documentType: DetectedDocumentType
  extractedData: Record<string, unknown>
}): CandidateField[] {
  const candidates: CandidateField[] = []

  const push = (sourceField: string, targetPath: string) => {
    const value = input.extractedData[sourceField]
    if (!hasMeaningfulValue(value)) {
      return
    }

    candidates.push({ sourceField, targetPath, value })
  }

  if (input.documentType === 'carfax' || input.documentType === 'autocheck') {
    push('lastReportedMileage', 'serviceHistory.latestMileage')
    push('ownerCount', 'ownershipHistory.ownerCount')
    push('openRecallSummary', 'recall.summary')
    push('recallStatus', 'recall.status')
    push('titleHistorySummary', 'titleHistory.titleStatus')

    if (input.documentType === 'carfax') {
      push('serviceHistoryCount', 'serviceHistory.eventCount')
      push('damageOrAccidentSummary', 'accident.summary')
    }

    if (input.documentType === 'autocheck') {
      push('serviceRecordCount', 'serviceHistory.eventCount')
      push('lienOrLoanStatus', 'titleProblem.lienStatus')
      push('odometerCheckSummary', 'titleHistory.odometerCheckSummary')
    }
  }

  if (input.documentType === 'choice_contract') {
    push('mileageAtSale', 'documentEvidence.contract.mileageAtSale')
    push('vehiclePurchaseDate', 'documentEvidence.contract.vehiclePurchaseDate')
    push('agreementPurchaseDate', 'documentEvidence.contract.agreementPurchaseDate')
    push('agreementNumber', 'documentEvidence.contract.agreementNumber')
    push('agreementPrice', 'documentEvidence.contract.agreementPrice')
    push('coverageLevel', 'documentEvidence.contract.coverageLevel')
    push('termMonths', 'documentEvidence.contract.termMonths')
    push('termMiles', 'documentEvidence.contract.termMiles')
    push('deductible', 'documentEvidence.contract.deductible')
    push('waitingPeriodMarker', 'documentEvidence.contract.waitingPeriodMarker')
  }

  return candidates
}

function cloneDocumentEvidenceSection(vinDataResult: Record<string, unknown>): Record<string, unknown> {
  const documentEvidence = asRecord(vinDataResult.documentEvidence)
  const documents = asRecord(documentEvidence.documents)
  const provenance = asRecord(documentEvidence.provenance)

  return {
    ...documentEvidence,
    documents,
    provenance
  }
}

function resolveApplyStatus(input: {
  appliedFields: string[]
  skippedFields: string[]
  conflictFields: FieldConflict[]
}): EvidenceApplyStatus {
  if (input.appliedFields.length > 0 && input.conflictFields.length === 0) {
    return input.skippedFields.length > 0 ? 'partial' : 'applied'
  }

  if (input.appliedFields.length > 0 && input.conflictFields.length > 0) {
    return 'partial'
  }

  if (input.conflictFields.length > 0) {
    return 'conflict'
  }

  return 'skipped'
}

export function applyUploadedDocumentEvidence(input: ApplyInput): EvidenceApplyResult {
  const appliedAt = new Date().toISOString()
  const evidenceSource = input.source || 'uploaded_document'
  const nextVinDataResult = asRecord(input.vinDataResult)

  const skippedReasons: string[] = []
  const conflicts: FieldConflict[] = []
  const applied: string[] = []
  const appliedDetails: AppliedFieldDetail[] = []

  if (!SUPPORTED_TYPES.has(input.documentType)) {
    skippedReasons.push('unsupported_document_type')
  }

  if (input.matchStatus !== 'matched') {
    skippedReasons.push(`match_status_${input.matchStatus}`)
  }

  if (input.extractionStatus !== 'extracted' && input.extractionStatus !== 'partial') {
    skippedReasons.push(`extraction_status_${input.extractionStatus}`)
  }

  if (!input.extractedData || Object.keys(input.extractedData).length === 0) {
    skippedReasons.push('missing_extracted_data')
  }

  if (skippedReasons.length === 0) {
    const candidates = buildFieldCandidates({
      documentType: input.documentType,
      extractedData: input.extractedData as Record<string, unknown>
    })

    if (candidates.length === 0) {
      skippedReasons.push('no_supported_fields_extracted')
    }

    for (const candidate of candidates) {
      const existing = getValueAtPath(nextVinDataResult, candidate.targetPath)

      if (existing === undefined || existing === null || (typeof existing === 'string' && existing.trim().length === 0)) {
        setValueAtPath(nextVinDataResult, candidate.targetPath, candidate.value)
        applied.push(candidate.targetPath)
        appliedDetails.push({
          field: candidate.targetPath,
          value: candidate.value,
          source: evidenceSource,
          sourceDocumentId: input.documentId,
          sourceDocumentType: input.documentType,
          appliedAt
        })

        continue
      }

      if (valuesEqual(candidate.targetPath, existing, candidate.value)) {
        skippedReasons.push(`${candidate.targetPath}:already_set`)
        continue
      }

      if (
        (typeof existing === 'string' || typeof existing === 'number' || typeof existing === 'boolean') &&
        (typeof candidate.value === 'string' || typeof candidate.value === 'number' || typeof candidate.value === 'boolean')
      ) {
        conflicts.push({
          field: candidate.targetPath,
          existing,
          incoming: candidate.value,
          reason: 'existing_value_differs'
        })
        continue
      }

      skippedReasons.push(`${candidate.targetPath}:unsupported_existing_shape`)
    }
  }

  const applyStatus = resolveApplyStatus({
    appliedFields: applied,
    skippedFields: skippedReasons,
    conflictFields: conflicts
  })

  const evidenceSection = cloneDocumentEvidenceSection(nextVinDataResult)
  const documents = asRecord(evidenceSection.documents)
  const provenance = asRecord(evidenceSection.provenance)
  const conflictsLog = Array.isArray(evidenceSection.conflicts)
    ? [...(evidenceSection.conflicts as unknown[])]
    : []

  documents[input.documentId] = {
    documentId: input.documentId,
    documentType: input.documentType,
    applyStatus,
    appliedAt,
    appliedFields: applied,
    skippedFields: skippedReasons,
    conflictFields: conflicts,
    source: evidenceSource
  }

  for (const detail of appliedDetails) {
    provenance[detail.field] = {
      source: detail.source,
      sourceDocumentId: detail.sourceDocumentId,
      sourceDocumentType: detail.sourceDocumentType,
      appliedAt: detail.appliedAt
    }
  }

  if (conflicts.length > 0) {
    conflictsLog.push(
      ...conflicts.map((conflict) => ({
        ...conflict,
        documentId: input.documentId,
        documentType: input.documentType,
        detectedAt: appliedAt
      }))
    )
  }

  nextVinDataResult.documentEvidence = {
    ...evidenceSection,
    documents,
    provenance,
    conflicts: conflictsLog,
    lastAppliedAt: appliedAt
  }

  return {
    applyStatus,
    appliedFields: applied,
    skippedFields: skippedReasons,
    conflictFields: conflicts,
    appliedFieldDetails: appliedDetails,
    appliedAt,
    nextVinDataResult,
    didMutateClaimEvidence: applied.length > 0 || conflicts.length > 0 || skippedReasons.length > 0
  }
}

export function mergeExtractedDataWithEvidenceApply(
  extractedData: Record<string, unknown> | null,
  applyResult: EvidenceApplyResult
): Record<string, unknown> {
  const base = extractedData ? { ...extractedData } : {}

  base.__evidenceApply = {
    applyStatus: applyResult.applyStatus,
    appliedAt: applyResult.appliedAt,
    appliedFields: applyResult.appliedFields,
    skippedFields: applyResult.skippedFields,
    conflictFields: applyResult.conflictFields,
    source: 'uploaded_document'
  }

  return base
}
