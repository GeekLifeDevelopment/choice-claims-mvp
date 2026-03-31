import '../../../../../../lib/config/ensure-database-url'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { writeAuditLog } from '../../../../../../lib/audit/write-audit-log'
import { prisma } from '../../../../../../lib/prisma'
import { isClaimLockedForProcessing } from '../../../../../../lib/review/claim-lock'
import { enqueueReviewSummaryForClaim } from '../../../../../../lib/review/enqueue-review-summary'

type RouteContext = {
  params: Promise<{ id: string }>
}

type WinnerSelection = 'existing' | 'incoming'

type ConflictResolutionRecord = {
  field: string
  reason: string
  resolvedAt: string
  resolvedBy: string
  winner: WinnerSelection
  winningValue: unknown
  winningSource: string | null
  losingValue: unknown
  losingSource: string | null
  documentId: string | null
  documentType: string | null
  detectedAt: string | null
  note: string | null
}

const MAX_REVIEWER_NOTE_LENGTH = 2000
const SUPPORTED_CONFLICT_PATHS = new Set<string>([
  'documentEvidence.contract.vehiclePurchaseDate',
  'documentEvidence.contract.agreementPurchaseDate',
  'documentEvidence.contract.mileageAtSale',
  'serviceHistory.latestMileage',
  'documentEvidence.contract.agreementNumber',
  'documentEvidence.contract.deductible',
  'documentEvidence.contract.termMonths',
  'documentEvidence.contract.termMiles',
  'documentEvidence.contract.coverageLevel',
  'documentEvidence.contract.planName',
  'documentEvidence.contract.warrantyCoverageSummary',
  'valuation.contextNote',
  'documentEvidence.contract.obdCodes'
])

function buildClaimDetailUrl(requestUrl: string, claimId: string, result: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('conflictResolution', result)
  return url
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
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
  let cursor = root

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

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right) && left === right
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left.trim() === right.trim()
  }

  return JSON.stringify(left) === JSON.stringify(right)
}

function buildConflictKey(input: {
  field: string
  documentId: string | null
  detectedAt: string | null
}): string {
  return [input.field, input.documentId || '', input.detectedAt || ''].join('|')
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params
  const formData = await request.formData()

  const conflictFieldRaw = formData.get('conflictField')
  const conflictDocumentIdRaw = formData.get('conflictDocumentId')
  const conflictDetectedAtRaw = formData.get('conflictDetectedAt')
  const winnerRaw = formData.get('winner')
  const reviewerNoteRaw = formData.get('reviewerNote')

  const conflictField = typeof conflictFieldRaw === 'string' ? conflictFieldRaw.trim() : ''
  const conflictDocumentId = typeof conflictDocumentIdRaw === 'string' && conflictDocumentIdRaw.trim().length > 0
    ? conflictDocumentIdRaw.trim()
    : null
  const conflictDetectedAt = typeof conflictDetectedAtRaw === 'string' && conflictDetectedAtRaw.trim().length > 0
    ? conflictDetectedAtRaw.trim()
    : null
  const winner = winnerRaw === 'incoming' ? 'incoming' : winnerRaw === 'existing' ? 'existing' : null
  const reviewerNote = typeof reviewerNoteRaw === 'string' ? reviewerNoteRaw.trim() : ''

  if (!SUPPORTED_CONFLICT_PATHS.has(conflictField)) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'unsupported-slot'), { status: 303 })
  }

  if (!winner) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid'), { status: 303 })
  }

  if (reviewerNote.length > MAX_REVIEWER_NOTE_LENGTH) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid-note'), { status: 303 })
  }

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      reviewDecision: true,
      vinDataResult: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  if (isClaimLockedForProcessing(claim)) {
    await writeAuditLog({
      action: 'evidence_conflict_resolution_blocked',
      claimId: claim.id,
      metadata: {
        claimNumber: claim.claimNumber,
        reason: 'locked_final_decision',
        field: conflictField,
        winner,
        reviewer: 'reviewer'
      }
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), { status: 303 })
  }

  const nowIso = new Date().toISOString()
  const nextVinDataResult = asRecord(claim.vinDataResult)
  const baseVinDataResult = asRecord(claim.vinDataResult)
  const documentEvidence = asRecord(nextVinDataResult.documentEvidence)
  const provenance = asRecord(documentEvidence.provenance)
  const documents = asRecord(documentEvidence.documents)
  const conflicts = Array.isArray(documentEvidence.conflicts) ? [...documentEvidence.conflicts] : []

  const targetKey = buildConflictKey({
    field: conflictField,
    documentId: conflictDocumentId,
    detectedAt: conflictDetectedAt
  })

  const conflictIndex = conflicts.findIndex((entry) => {
    const record = asRecord(entry)
    const field = getOptionalString(record.field)
    if (!field) {
      return false
    }

    const key = buildConflictKey({
      field,
      documentId: getOptionalString(record.documentId),
      detectedAt: getOptionalString(record.detectedAt)
    })

    return key === targetKey
  })

  if (conflictIndex === -1) {
    await writeAuditLog({
      action: 'evidence_conflict_resolution_blocked',
      claimId: claim.id,
      metadata: {
        claimNumber: claim.claimNumber,
        reason: 'conflict_not_found',
        field: conflictField,
        winner,
        reviewer: 'reviewer'
      }
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'stale'), { status: 303 })
  }

  const conflictRecord = asRecord(conflicts[conflictIndex])
  const existingValue = conflictRecord.existing
  const incomingValue = conflictRecord.incoming
  const conflictDocumentIdFromRecord = getOptionalString(conflictRecord.documentId)
  const conflictDocumentType = getOptionalString(conflictRecord.documentType)
  const conflictReason = getOptionalString(conflictRecord.reason) || 'existing_value_differs'
  const evidenceDocumentRecord = asRecord(
    (conflictDocumentIdFromRecord && documents[conflictDocumentIdFromRecord]) || {}
  )

  const existingProvenance = asRecord(provenance[conflictField])

  const winningValue = winner === 'incoming' ? incomingValue : existingValue
  const losingValue = winner === 'incoming' ? existingValue : incomingValue
  const winningSource =
    winner === 'incoming'
      ? getOptionalString(evidenceDocumentRecord.source) || 'uploaded_document'
      : getOptionalString(existingProvenance.source) || 'existing_claim_value'
  const losingSource =
    winner === 'incoming'
      ? getOptionalString(existingProvenance.source) || 'existing_claim_value'
      : getOptionalString(evidenceDocumentRecord.source) || 'uploaded_document'

  const currentValue = getValueAtPath(baseVinDataResult, conflictField)
  const valueChanged = winner === 'incoming' && !valuesEqual(currentValue, winningValue)

  if (winner === 'incoming') {
    setValueAtPath(nextVinDataResult, conflictField, winningValue)

    provenance[conflictField] = {
      ...existingProvenance,
      source: winningSource,
      sourceDocumentId: conflictDocumentIdFromRecord,
      sourceDocumentType: conflictDocumentType,
      appliedAt: nowIso,
      resolvedBy: 'reviewer',
      resolvedAt: nowIso,
      resolutionReason: 'evidence_conflict',
      resolutionNote: reviewerNote || null
    }
  }

  const remainingConflicts = conflicts.filter((_, index) => index !== conflictIndex)
  const existingResolutions = Array.isArray(documentEvidence.conflictResolutions)
    ? [...documentEvidence.conflictResolutions]
    : []

  const resolutionRecord: ConflictResolutionRecord = {
    field: conflictField,
    reason: conflictReason,
    resolvedAt: nowIso,
    resolvedBy: 'reviewer',
    winner,
    winningValue,
    winningSource,
    losingValue,
    losingSource,
    documentId: conflictDocumentIdFromRecord,
    documentType: conflictDocumentType,
    detectedAt: getOptionalString(conflictRecord.detectedAt),
    note: reviewerNote || null
  }

  existingResolutions.push(resolutionRecord)

  nextVinDataResult.documentEvidence = {
    ...documentEvidence,
    provenance,
    conflicts: remainingConflicts,
    conflictResolutions: existingResolutions,
    lastAppliedAt: nowIso
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.claim.updateMany({
        where: {
          id: claim.id,
          OR: [{ reviewDecision: null }, { reviewDecision: 'NeedsReview' }]
        },
        data: {
          vinDataResult: nextVinDataResult as Prisma.InputJsonValue
        }
      })

      if (updated.count === 0) {
        throw new Error('claim_locked_final_decision')
      }

      await writeAuditLog({
        client: tx,
        action: 'evidence_conflict_resolved',
        claimId: claim.id,
        metadata: {
          claimNumber: claim.claimNumber,
          field: conflictField,
          winner,
          winningSource,
          losingSource,
          winningValue,
          losingValue,
          documentId: conflictDocumentIdFromRecord,
          documentType: conflictDocumentType,
          resolvedBy: 'reviewer',
          reviewerNote: reviewerNote || null,
          reason: conflictReason,
          valueChanged
        }
      })
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'claim_locked_final_decision') {
      await writeAuditLog({
        action: 'evidence_conflict_resolution_blocked',
        claimId: claim.id,
        metadata: {
          claimNumber: claim.claimNumber,
          reason: 'locked_final_decision',
          field: conflictField,
          winner,
          reviewer: 'reviewer'
        }
      })

      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
        status: 303
      })
    }

    console.error('[resolve_conflict] save failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error: error instanceof Error ? error.message : 'unknown_error'
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'error'), { status: 303 })
  }

  if (!valueChanged) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'saved'), { status: 303 })
  }

  const refreshResult = await enqueueReviewSummaryForClaim(claim.id, 'manual')

  await writeAuditLog({
    action: 'evidence_conflict_resolution_triggered_refresh',
    claimId: claim.id,
    metadata: {
      claimNumber: claim.claimNumber,
      field: conflictField,
      winner,
      queueEnqueued: refreshResult.enqueued,
      queueReason: refreshResult.reason,
      queueName: refreshResult.queueName ?? null,
      jobName: refreshResult.jobName ?? null,
      jobId: refreshResult.jobId ?? null
    }
  })

  return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'saved_refresh'), { status: 303 })
}
