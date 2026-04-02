import '../../../../../../lib/config/ensure-database-url'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { writeAuditLog } from '../../../../../../lib/audit/write-audit-log'
import { prisma } from '../../../../../../lib/prisma'
import { enqueueReviewSummaryForClaim } from '../../../../../../lib/review/enqueue-review-summary'

type RouteContext = {
  params: Promise<{ id: string }>
}

type ManualFieldKey =
  | 'purchaseDate'
  | 'purchaseMileage'
  | 'currentMileage'
  | 'agreementNumber'
  | 'deductible'
  | 'termMonths'
  | 'termMiles'
  | 'coverageLevel'
  | 'planName'
  | 'warrantyCoverageSummary'
  | 'valuationContextNote'
  | 'obdCodes'

type ParsedManualField = {
  key: ManualFieldKey
  path: string
  value: string | number | string[]
}

const MAX_TEXT_LENGTH = 2000
const MAX_OBD_CODES_LENGTH = 1000

function resolveRequestOrigin(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()

  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.split(',')[0]?.trim()
  if (host) {
    const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'
    return `${proto}://${host}`
  }

  return new URL(request.url).origin
}

function buildClaimDetailUrl(request: Request, claimId: string, status: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, resolveRequestOrigin(request))
  url.searchParams.set('manualEvidence', status)
  return url
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
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

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0
  }

  return false
}

function parseOptionalNonNegativeNumber(raw: FormDataEntryValue | null): number | null | 'invalid' {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.replace(/[$,\s]/g, '')
  const parsed = Number(normalized)

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'invalid'
  }

  return parsed
}

function parseOptionalDate(raw: FormDataEntryValue | null): string | null | 'invalid' {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return 'invalid'
  }

  return parsed.toISOString().slice(0, 10)
}

function parseOptionalText(raw: FormDataEntryValue | null): string | null | 'invalid' {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.length > MAX_TEXT_LENGTH) {
    return 'invalid'
  }

  return trimmed
}

function parseOptionalObdCodes(raw: FormDataEntryValue | null): string[] | null | 'invalid' {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.length > MAX_OBD_CODES_LENGTH) {
    return 'invalid'
  }

  const codes = trimmed
    .split(/[\n,;\s]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0)

  if (codes.length === 0) {
    return null
  }

  return Array.from(new Set(codes))
}

function parseManualEvidence(formData: FormData): ParsedManualField[] | 'invalid' {
  const fields: ParsedManualField[] = []

  const purchaseDate = parseOptionalDate(formData.get('purchaseDate'))
  if (purchaseDate === 'invalid') {
    return 'invalid'
  }
  if (purchaseDate) {
    fields.push({ key: 'purchaseDate', path: 'documentEvidence.contract.vehiclePurchaseDate', value: purchaseDate })
  }

  const purchaseMileage = parseOptionalNonNegativeNumber(formData.get('purchaseMileage'))
  if (purchaseMileage === 'invalid') {
    return 'invalid'
  }
  if (typeof purchaseMileage === 'number') {
    fields.push({ key: 'purchaseMileage', path: 'documentEvidence.contract.mileageAtSale', value: purchaseMileage })
  }

  const currentMileage = parseOptionalNonNegativeNumber(formData.get('currentMileage'))
  if (currentMileage === 'invalid') {
    return 'invalid'
  }
  if (typeof currentMileage === 'number') {
    fields.push({ key: 'currentMileage', path: 'serviceHistory.latestMileage', value: currentMileage })
  }

  const agreementNumber = parseOptionalText(formData.get('agreementNumber'))
  if (agreementNumber === 'invalid') {
    return 'invalid'
  }
  if (agreementNumber) {
    fields.push({ key: 'agreementNumber', path: 'documentEvidence.contract.agreementNumber', value: agreementNumber })
  }

  const deductible = parseOptionalNonNegativeNumber(formData.get('deductible'))
  if (deductible === 'invalid') {
    return 'invalid'
  }
  if (typeof deductible === 'number') {
    fields.push({ key: 'deductible', path: 'documentEvidence.contract.deductible', value: deductible })
  }

  const termMonths = parseOptionalNonNegativeNumber(formData.get('termMonths'))
  if (termMonths === 'invalid') {
    return 'invalid'
  }
  if (typeof termMonths === 'number') {
    fields.push({ key: 'termMonths', path: 'documentEvidence.contract.termMonths', value: termMonths })
  }

  const termMiles = parseOptionalNonNegativeNumber(formData.get('termMiles'))
  if (termMiles === 'invalid') {
    return 'invalid'
  }
  if (typeof termMiles === 'number') {
    fields.push({ key: 'termMiles', path: 'documentEvidence.contract.termMiles', value: termMiles })
  }

  const coverageLevel = parseOptionalText(formData.get('coverageLevel'))
  if (coverageLevel === 'invalid') {
    return 'invalid'
  }
  if (coverageLevel) {
    fields.push({ key: 'coverageLevel', path: 'documentEvidence.contract.coverageLevel', value: coverageLevel })
  }

  const planName = parseOptionalText(formData.get('planName'))
  if (planName === 'invalid') {
    return 'invalid'
  }
  if (planName) {
    fields.push({ key: 'planName', path: 'documentEvidence.contract.planName', value: planName })
  }

  const warrantyCoverageSummary = parseOptionalText(formData.get('warrantyCoverageSummary'))
  if (warrantyCoverageSummary === 'invalid') {
    return 'invalid'
  }
  if (warrantyCoverageSummary) {
    fields.push({
      key: 'warrantyCoverageSummary',
      path: 'documentEvidence.contract.warrantyCoverageSummary',
      value: warrantyCoverageSummary
    })
  }

  const valuationContextNote = parseOptionalText(formData.get('valuationContextNote'))
  if (valuationContextNote === 'invalid') {
    return 'invalid'
  }
  if (valuationContextNote) {
    fields.push({ key: 'valuationContextNote', path: 'valuation.contextNote', value: valuationContextNote })
  }

  const obdCodes = parseOptionalObdCodes(formData.get('obdCodes'))
  if (obdCodes === 'invalid') {
    return 'invalid'
  }
  if (obdCodes) {
    fields.push({ key: 'obdCodes', path: 'documentEvidence.contract.obdCodes', value: obdCodes })
  }

  return fields
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  const formData = await request.formData()
  const parsedFields = parseManualEvidence(formData)

  if (parsedFields === 'invalid') {
    return NextResponse.redirect(buildClaimDetailUrl(request, id, 'invalid'), { status: 303 })
  }

  const reviewerNoteRaw = formData.get('reviewerNote')
  const reviewerNote = typeof reviewerNoteRaw === 'string' ? reviewerNoteRaw.trim() : ''
  if (reviewerNote.length > MAX_TEXT_LENGTH) {
    return NextResponse.redirect(buildClaimDetailUrl(request, id, 'invalid-note'), { status: 303 })
  }

  if (parsedFields.length === 0) {
    return NextResponse.redirect(buildClaimDetailUrl(request, id, 'empty'), { status: 303 })
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
    return NextResponse.redirect(buildClaimDetailUrl(request, id, 'not-found'), { status: 303 })
  }

  const nowIso = new Date().toISOString()
  const source = 'manual_reviewer_entry'
  const enteredBy = 'reviewer'

  const baseVinDataResult = asRecord(claim.vinDataResult)
  const nextVinDataResult = asRecord(claim.vinDataResult)
  const evidenceSection = asRecord(nextVinDataResult.documentEvidence)
  const provenance = asRecord(evidenceSection.provenance)

  const appliedFields: string[] = []
  const blockedFields: string[] = []

  for (const field of parsedFields) {
    const existing = getValueAtPath(baseVinDataResult, field.path)
    if (hasMeaningfulValue(existing)) {
      blockedFields.push(field.path)
      continue
    }

    setValueAtPath(nextVinDataResult, field.path, field.value)
    provenance[field.path] = {
      source,
      sourceDocumentId: null,
      sourceDocumentType: 'manual_entry',
      appliedAt: nowIso,
      enteredBy,
      note: reviewerNote || null,
      slot: field.key
    }
    appliedFields.push(field.path)
  }

  if (appliedFields.length === 0) {
    await writeAuditLog({
      action: 'manual_evidence_entered',
      claimId: claim.id,
      metadata: {
        claimNumber: claim.claimNumber,
        source,
        enteredBy,
        appliedFields: [],
        blockedFields,
        reviewerNote: reviewerNote || null,
        reason: 'all_fields_already_populated'
      }
    })

    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'blocked-populated'), { status: 303 })
  }

  const currentEvidenceSection = asRecord(nextVinDataResult.documentEvidence)
  nextVinDataResult.documentEvidence = {
    ...currentEvidenceSection,
    provenance,
    lastAppliedAt: nowIso
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.claim.updateMany({
        where: {
          id: claim.id
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
        action: 'manual_evidence_entered',
        claimId: claim.id,
        metadata: {
          claimNumber: claim.claimNumber,
          source,
          enteredBy,
          appliedFields,
          blockedFields,
          reviewerNote: reviewerNote || null
        }
      })
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'claim_locked_final_decision') {
      return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'locked_final_decision'), {
        status: 303
      })
    }

    console.error('[manual_evidence] save failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error: error instanceof Error ? error.message : 'unknown_error'
    })

    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'error'), { status: 303 })
  }

  const refreshResult = await enqueueReviewSummaryForClaim(claim.id, 'manual', {
    allowLockedFinalDecision: true
  })

  await writeAuditLog({
    action: 'manual_evidence_triggered_refresh',
    claimId: claim.id,
    metadata: {
      claimNumber: claim.claimNumber,
      source,
      enteredBy,
      appliedFields,
      queueEnqueued: refreshResult.enqueued,
      queueReason: refreshResult.reason,
      queueName: refreshResult.queueName ?? null,
      jobName: refreshResult.jobName ?? null,
      jobId: refreshResult.jobId ?? null,
      queueReusedInFlight: refreshResult.reusedInFlight ?? false
    }
  })

  return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'saved'), { status: 303 })
}
