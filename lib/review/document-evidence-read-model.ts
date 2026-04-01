type ClaimDocumentRecord = Record<string, unknown>

export type EvidenceSlotId =
  | 'purchaseDate'
  | 'purchaseMileage'
  | 'currentMileage'
  | 'agreementNumber'
  | 'deductible'
  | 'termMonths'
  | 'termMiles'
  | 'ownerCount'
  | 'recallSummary'
  | 'recallStatus'
  | 'titleStatus'
  | 'titleRisk'
  | 'serviceHistoryCount'
  | 'warrantyCoverageData'
  | 'coverageLevel'
  | 'valuationContext'
  | 'damageOrAccidentSummary'

export type ClaimDocumentEvidenceContributionState = 'applied' | 'conflict'

export type ClaimDocumentEvidenceSlotContribution = {
  fieldPath: string
  fieldLabel: string
  state: ClaimDocumentEvidenceContributionState
  sourceLabel: string
  sourceDocumentId: string | null
  sourceDocumentName: string | null
  sourceDocumentType: string | null
  extractionMethod: string | null
  extractionSource: string | null
}

export type ClaimDocumentEvidenceSlot = {
  slotId: EvidenceSlotId
  slotLabel: string
  missingKeywords: string[]
  coveredMissing: string[]
  satisfied: boolean
  contributions: ClaimDocumentEvidenceSlotContribution[]
}

export type ClaimDocumentEvidenceConflict = {
  slotId: EvidenceSlotId | null
  slotLabel: string | null
  fieldPath: string
  fieldLabel: string
  reason: string
  sourceLabel: string
  sourceDocumentId: string | null
  sourceDocumentName: string | null
  sourceDocumentType: string | null
  extractionMethod: string | null
  extractionSource: string | null
}

export type ClaimDocumentEvidenceGapCoverage = {
  reduced: string[]
  remaining: string[]
  reducedBySlot: Array<{
    slotId: EvidenceSlotId
    slotLabel: string
    gaps: string[]
  }>
}

export type ClaimDocumentEvidenceReadModel = {
  totalDocuments: number
  processedDocuments: number
  contributedDocuments: number
  conflictOnlyDocuments: number
  skippedDocuments: number
  pendingOrReprocessDocuments: number
  appliedFieldCount: number
  satisfiedSlotCount: number
  slots: ClaimDocumentEvidenceSlot[]
  conflicts: ClaimDocumentEvidenceConflict[]
  gapCoverage: ClaimDocumentEvidenceGapCoverage
}

type EvidenceSlotConfig = {
  slotId: EvidenceSlotId
  slotLabel: string
  fieldPaths: string[]
  missingKeywords: string[]
}

const DOCUMENT_EVIDENCE_FIELD_LABELS: Record<string, string> = {
  'serviceHistory.latestMileage': 'Current/latest mileage',
  'ownershipHistory.ownerCount': 'Owner Count',
  'recall.summary': 'Recall Summary',
  'recall.status': 'Recall Status',
  'titleHistory.titleStatus': 'Title Status',
  'serviceHistory.eventCount': 'Service History Count',
  'accident.summary': 'Damage/Accident Summary',
  'titleProblem.lienStatus': 'Lien Status',
  'titleHistory.odometerCheckSummary': 'Odometer Check Summary',
  'documentEvidence.contract.mileageAtSale': 'Purchase Mileage',
  'documentEvidence.contract.vehiclePurchaseDate': 'Purchase Date',
  'documentEvidence.contract.agreementPurchaseDate': 'Purchase Date',
  'documentEvidence.contract.agreementNumber': 'Agreement Number',
  'documentEvidence.contract.agreementPrice': 'Agreement Price',
  'documentEvidence.contract.coverageLevel': 'Coverage Level',
  'documentEvidence.contract.termMonths': 'Term Months',
  'documentEvidence.contract.termMiles': 'Term Miles',
  'documentEvidence.contract.deductible': 'Deductible',
  'documentEvidence.contract.waitingPeriodMarker': 'Waiting Period',
  'documentEvidence.contract.planName': 'Coverage Level',
  'documentEvidence.contract.warrantyCoverageSummary': 'Warranty Coverage',
  'documentEvidence.contract.obdCodes': 'OBD Codes',
  'valuation.contextNote': 'Valuation Context'
}

const SLOT_CONFIG: EvidenceSlotConfig[] = [
  {
    slotId: 'purchaseDate',
    slotLabel: 'Purchase Date',
    fieldPaths: ['documentEvidence.contract.vehiclePurchaseDate', 'documentEvidence.contract.agreementPurchaseDate'],
    missingKeywords: ['days_since_purchase', 'purchase date']
  },
  {
    slotId: 'purchaseMileage',
    slotLabel: 'Purchase Mileage',
    fieldPaths: ['documentEvidence.contract.mileageAtSale'],
    missingKeywords: ['miles_since_purchase', 'purchase mileage', 'mileage']
  },
  {
    slotId: 'currentMileage',
    slotLabel: 'Current/latest mileage',
    fieldPaths: ['serviceHistory.latestMileage'],
    missingKeywords: ['miles_since_purchase', 'current mileage', 'mileage']
  },
  {
    slotId: 'agreementNumber',
    slotLabel: 'Agreement Number',
    fieldPaths: ['documentEvidence.contract.agreementNumber'],
    missingKeywords: ['warranty_support', 'agreement', 'contract']
  },
  {
    slotId: 'deductible',
    slotLabel: 'Deductible',
    fieldPaths: ['documentEvidence.contract.deductible'],
    missingKeywords: ['warranty_support', 'deductible', 'warranty']
  },
  {
    slotId: 'termMonths',
    slotLabel: 'Term Months',
    fieldPaths: ['documentEvidence.contract.termMonths'],
    missingKeywords: ['warranty_support', 'term', 'contract']
  },
  {
    slotId: 'termMiles',
    slotLabel: 'Term Miles',
    fieldPaths: ['documentEvidence.contract.termMiles'],
    missingKeywords: ['warranty_support', 'term', 'mileage', 'contract']
  },
  {
    slotId: 'ownerCount',
    slotLabel: 'Owner Count',
    fieldPaths: ['ownershipHistory.ownerCount'],
    missingKeywords: ['owner', 'history']
  },
  {
    slotId: 'recallSummary',
    slotLabel: 'Recall Summary',
    fieldPaths: ['recall.summary'],
    missingKeywords: ['recall_relevance', 'recall']
  },
  {
    slotId: 'recallStatus',
    slotLabel: 'Recall Status',
    fieldPaths: ['recall.status'],
    missingKeywords: ['recall_relevance', 'recall']
  },
  {
    slotId: 'titleStatus',
    slotLabel: 'Title Status',
    fieldPaths: ['titleHistory.titleStatus'],
    missingKeywords: ['branded_title', 'title']
  },
  {
    slotId: 'titleRisk',
    slotLabel: 'Title Risk Indicators',
    fieldPaths: ['titleProblem.lienStatus', 'titleHistory.odometerCheckSummary'],
    missingKeywords: ['branded_title', 'title']
  },
  {
    slotId: 'serviceHistoryCount',
    slotLabel: 'Service History Count',
    fieldPaths: ['serviceHistory.eventCount'],
    missingKeywords: ['maintenance_history', 'service']
  },
  {
    slotId: 'warrantyCoverageData',
    slotLabel: 'Warranty Coverage',
    fieldPaths: [
      'documentEvidence.contract.waitingPeriodMarker',
      'documentEvidence.contract.agreementPrice',
      'documentEvidence.contract.warrantyCoverageSummary',
      'documentEvidence.contract.obdCodes'
    ],
    missingKeywords: ['warranty_support', 'warranty', 'coverage']
  },
  {
    slotId: 'coverageLevel',
    slotLabel: 'Coverage Level',
    fieldPaths: ['documentEvidence.contract.coverageLevel', 'documentEvidence.contract.planName'],
    missingKeywords: ['warranty_support', 'coverage', 'plan']
  },
  {
    slotId: 'valuationContext',
    slotLabel: 'Valuation Context',
    fieldPaths: [
      'valuation.estimatedValue',
      'valuation.retailValue',
      'valuation.tradeInValue',
      'valuation.confidence',
      'valuation.contextNote'
    ],
    missingKeywords: ['valuation']
  },
  {
    slotId: 'damageOrAccidentSummary',
    slotLabel: 'Damage/Accident Summary',
    fieldPaths: ['accident.summary'],
    missingKeywords: ['accident', 'damage']
  }
]

const PATH_TO_SLOT = new Map<string, EvidenceSlotId>()
for (const slot of SLOT_CONFIG) {
  for (const fieldPath of slot.fieldPaths) {
    PATH_TO_SLOT.set(fieldPath, slot.slotId)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => getOptionalString(entry)).filter((entry): entry is string => Boolean(entry))
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

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }

  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (typeof value === 'boolean') {
    return true
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0
  }

  return false
}

function formatDocumentEvidenceFieldLabel(fieldPath: string): string {
  const exactLabel = DOCUMENT_EVIDENCE_FIELD_LABELS[fieldPath]
  if (exactLabel) {
    return exactLabel
  }

  const finalSegment = fieldPath.split('.').pop() || fieldPath
  return finalSegment
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function getDocumentExtractionMethod(documentRecord: Record<string, unknown>): string | null {
  const extractedData = asRecord(documentRecord.extractedData)
  const fallbackRecord = asRecord(extractedData.__choiceContractFallback)
  return getOptionalString(fallbackRecord.method)
}

function getDocumentExtractionSource(input: {
  documentRecord: Record<string, unknown>
  provenanceSource: string | null
  evidenceDocumentSource: string | null
}): string | null {
  const extractedData = asRecord(input.documentRecord.extractedData)
  const applyRecord = asRecord(extractedData.__evidenceApply)
  return input.provenanceSource || input.evidenceDocumentSource || getOptionalString(applyRecord.source)
}

function addContributionIfMissing(
  slot: ClaimDocumentEvidenceSlot,
  contribution: ClaimDocumentEvidenceSlotContribution
): void {
  const key = [
    contribution.state,
    contribution.fieldPath,
    contribution.sourceDocumentId || '',
    contribution.sourceLabel
  ].join('|')

  const alreadyPresent = slot.contributions.some((entry) => {
    const entryKey = [entry.state, entry.fieldPath, entry.sourceDocumentId || '', entry.sourceLabel].join('|')
    return entryKey === key
  })

  if (!alreadyPresent) {
    slot.contributions.push(contribution)
  }
}

export function formatDocumentEvidenceSlotState(state: ClaimDocumentEvidenceContributionState): string {
  return state === 'applied' ? 'Applied' : 'Conflict'
}

export function buildClaimDocumentEvidenceReadModel(input: {
  vinDataResult: Record<string, unknown>
  claimDocuments: ClaimDocumentRecord[]
  adjudicationMissingData: string[]
}): ClaimDocumentEvidenceReadModel {
  const documentEvidence = asRecord(input.vinDataResult.documentEvidence)
  const evidenceDocuments = asRecord(documentEvidence.documents)
  const evidenceProvenance = asRecord(documentEvidence.provenance)
  const evidenceConflicts = Array.isArray(documentEvidence.conflicts) ? documentEvidence.conflicts : []

  const documentById = new Map<string, Record<string, unknown>>(
    input.claimDocuments.map((document) => [getOptionalString(document.id) || '', asRecord(document)])
  )

  const appliedContributionsByPath = new Map<string, ClaimDocumentEvidenceSlotContribution>()

  for (const [fieldPath, provenanceValue] of Object.entries(evidenceProvenance)) {
    const provenance = asRecord(provenanceValue)
    const sourceDocumentId = getOptionalString(provenance.sourceDocumentId)
    const sourceDocument = asRecord((sourceDocumentId && documentById.get(sourceDocumentId)) || {})
    const evidenceDocument = asRecord((sourceDocumentId && evidenceDocuments[sourceDocumentId]) || {})
    const provenanceSource = getOptionalString(provenance.source)
    const evidenceDocumentSource = getOptionalString(evidenceDocument.source)

    appliedContributionsByPath.set(fieldPath, {
      fieldPath,
      fieldLabel: formatDocumentEvidenceFieldLabel(fieldPath),
      state: 'applied',
      sourceLabel: provenanceSource || evidenceDocumentSource || 'uploaded_document',
      sourceDocumentId,
      sourceDocumentName: getOptionalString(sourceDocument.fileName),
      sourceDocumentType: getOptionalString(provenance.sourceDocumentType) || getOptionalString(sourceDocument.documentType),
      extractionMethod: getDocumentExtractionMethod(sourceDocument),
      extractionSource: getDocumentExtractionSource({
        documentRecord: sourceDocument,
        provenanceSource,
        evidenceDocumentSource
      })
    })
  }

  if (appliedContributionsByPath.size === 0) {
    for (const [documentId, evidenceDocumentValue] of Object.entries(evidenceDocuments)) {
      const evidenceDocument = asRecord(evidenceDocumentValue)
      const appliedFields = getOptionalStringArray(evidenceDocument.appliedFields)
      const sourceDocument = asRecord(documentById.get(documentId) || {})
      const evidenceDocumentSource = getOptionalString(evidenceDocument.source)

      for (const fieldPath of appliedFields) {
        if (!appliedContributionsByPath.has(fieldPath)) {
          appliedContributionsByPath.set(fieldPath, {
            fieldPath,
            fieldLabel: formatDocumentEvidenceFieldLabel(fieldPath),
            state: 'applied',
            sourceLabel: evidenceDocumentSource || 'uploaded_document',
            sourceDocumentId: documentId,
            sourceDocumentName: getOptionalString(sourceDocument.fileName),
            sourceDocumentType: getOptionalString(evidenceDocument.documentType) || getOptionalString(sourceDocument.documentType),
            extractionMethod: getDocumentExtractionMethod(sourceDocument),
            extractionSource: getDocumentExtractionSource({
              documentRecord: sourceDocument,
              provenanceSource: null,
              evidenceDocumentSource
            })
          })
        }
      }
    }
  }

  const slots = SLOT_CONFIG.map<ClaimDocumentEvidenceSlot>((config) => ({
    slotId: config.slotId,
    slotLabel: config.slotLabel,
    missingKeywords: config.missingKeywords,
    coveredMissing: [],
    satisfied: false,
    contributions: []
  }))
  const slotById = new Map<EvidenceSlotId, ClaimDocumentEvidenceSlot>(slots.map((slot) => [slot.slotId, slot]))

  for (const contribution of appliedContributionsByPath.values()) {
    const slotId = PATH_TO_SLOT.get(contribution.fieldPath)
    if (!slotId) {
      continue
    }

    if (!hasMeaningfulValue(getValueAtPath(input.vinDataResult, contribution.fieldPath))) {
      continue
    }

    const slot = slotById.get(slotId)
    if (!slot) {
      continue
    }

    addContributionIfMissing(slot, contribution)
  }

  const conflicts: ClaimDocumentEvidenceConflict[] = evidenceConflicts
    .map((entry) => {
      const conflict = asRecord(entry)
      const fieldPath = getOptionalString(conflict.field)
      if (!fieldPath) {
        return null
      }

      const slotId = PATH_TO_SLOT.get(fieldPath) || null
      const slot = slotId ? slotById.get(slotId) || null : null
      const sourceDocumentId = getOptionalString(conflict.documentId)
      const sourceDocument = asRecord((sourceDocumentId && documentById.get(sourceDocumentId)) || {})
      const evidenceDocument = asRecord((sourceDocumentId && evidenceDocuments[sourceDocumentId]) || {})
      const evidenceDocumentSource = getOptionalString(evidenceDocument.source)

      const conflictModel: ClaimDocumentEvidenceConflict = {
        slotId,
        slotLabel: slot ? slot.slotLabel : null,
        fieldPath,
        fieldLabel: formatDocumentEvidenceFieldLabel(fieldPath),
        reason: getOptionalString(conflict.reason) || 'existing_value_differs',
        sourceLabel: evidenceDocumentSource || 'uploaded_document',
        sourceDocumentId,
        sourceDocumentName: getOptionalString(sourceDocument.fileName),
        sourceDocumentType: getOptionalString(conflict.documentType) || getOptionalString(sourceDocument.documentType),
        extractionMethod: getDocumentExtractionMethod(sourceDocument),
        extractionSource: getDocumentExtractionSource({
          documentRecord: sourceDocument,
          provenanceSource: null,
          evidenceDocumentSource
        })
      }

      if (slot) {
        addContributionIfMissing(slot, {
          fieldPath,
          fieldLabel: conflictModel.fieldLabel,
          state: 'conflict',
          sourceLabel: conflictModel.sourceLabel,
          sourceDocumentId: conflictModel.sourceDocumentId,
          sourceDocumentName: conflictModel.sourceDocumentName,
          sourceDocumentType: conflictModel.sourceDocumentType,
          extractionMethod: conflictModel.extractionMethod,
          extractionSource: conflictModel.extractionSource
        })
      }

      return conflictModel
    })
    .filter((entry): entry is ClaimDocumentEvidenceConflict => Boolean(entry))

  for (const config of SLOT_CONFIG) {
    const slot = slotById.get(config.slotId)
    if (!slot) {
      continue
    }

    slot.satisfied = slot.contributions.some((entry) => entry.state === 'applied')

    slot.contributions.sort((left, right) => {
      const stateRank = left.state.localeCompare(right.state)
      if (stateRank !== 0) {
        return stateRank
      }

      const nameLeft = left.sourceDocumentName || left.sourceDocumentId || left.sourceLabel
      const nameRight = right.sourceDocumentName || right.sourceDocumentId || right.sourceLabel
      const nameRank = nameLeft.localeCompare(nameRight)
      if (nameRank !== 0) {
        return nameRank
      }

      return left.fieldLabel.localeCompare(right.fieldLabel)
    })
  }

  const normalizedMissing = uniqueSorted(
    input.adjudicationMissingData.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
  )

  for (const slot of slots) {
    slot.coveredMissing = normalizedMissing.filter((entry) => {
      const normalizedEntry = entry.toLowerCase()
      return slot.missingKeywords.some((keyword) => normalizedEntry.includes(keyword.toLowerCase()))
    })
  }

  const reducedSet = new Set<string>()
  const remainingSet = new Set<string>()

  for (const gap of normalizedMissing) {
    const coveringSlots = slots.filter((slot) => slot.coveredMissing.includes(gap))

    if (coveringSlots.length === 0) {
      remainingSet.add(gap)
      continue
    }

    if (coveringSlots.some((slot) => slot.satisfied)) {
      reducedSet.add(gap)
      continue
    }

    remainingSet.add(gap)
  }

  const reducedBySlot = slots
    .map((slot) => ({
      slotId: slot.slotId,
      slotLabel: slot.slotLabel,
      gaps: slot.coveredMissing.filter((gap) => reducedSet.has(gap))
    }))
    .filter((entry) => entry.gaps.length > 0)

  let processedDocuments = 0
  let contributedDocuments = 0
  let conflictOnlyDocuments = 0
  let skippedDocuments = 0
  let pendingOrReprocessDocuments = 0

  for (const document of input.claimDocuments) {
    const documentId = getOptionalString(document.id)
    const processingStatus = getOptionalString(document.processingStatus)
    const extractionStatus = getOptionalString(document.extractionStatus)
    const evidenceDocument = asRecord((documentId && evidenceDocuments[documentId]) || {})
    const applyStatus = getOptionalString(evidenceDocument.applyStatus)
    const appliedFields = getOptionalStringArray(evidenceDocument.appliedFields)
    const conflictFields = Array.isArray(evidenceDocument.conflictFields) ? evidenceDocument.conflictFields : []

    if (processingStatus === 'classified') {
      processedDocuments += 1
    }

    if (appliedFields.length > 0) {
      contributedDocuments += 1
    }

    if (appliedFields.length === 0 && conflictFields.length > 0) {
      conflictOnlyDocuments += 1
    }

    if (applyStatus === 'skipped') {
      skippedDocuments += 1
    }

    if (
      processingStatus === 'pending' ||
      extractionStatus === 'failed' ||
      (processingStatus === 'classified' && extractionStatus === 'partial')
    ) {
      pendingOrReprocessDocuments += 1
    }
  }

  const appliedFieldCount = uniqueSorted(
    slots.flatMap((slot) =>
      slot.contributions
        .filter((entry) => entry.state === 'applied' && entry.sourceLabel !== 'system_enrichment')
        .map((entry) => entry.fieldPath)
    )
  ).length

  return {
    totalDocuments: input.claimDocuments.length,
    processedDocuments,
    contributedDocuments,
    conflictOnlyDocuments,
    skippedDocuments,
    pendingOrReprocessDocuments,
    appliedFieldCount,
    satisfiedSlotCount: slots.filter((slot) => slot.satisfied).length,
    slots,
    conflicts,
    gapCoverage: {
      reduced: uniqueSorted(Array.from(reducedSet)),
      remaining: uniqueSorted(Array.from(remainingSet)),
      reducedBySlot
    }
  }
}