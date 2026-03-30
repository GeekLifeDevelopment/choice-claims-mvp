import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import {
  logClaimDocumentChoiceFallbackAttemptedAudit,
  logClaimDocumentChoiceFallbackFailedAudit,
  logClaimDocumentChoiceFallbackPartialAudit,
  logClaimDocumentChoiceFallbackSucceededAudit,
  logClaimDocumentClassifiedAudit,
  logClaimDocumentEvidenceAppliedAudit,
  logClaimDocumentEvidenceConflictDetectedAudit,
  logClaimDocumentEvidencePartiallyAppliedAudit,
  logClaimDocumentEvidenceSkippedAudit,
  logClaimDocumentEvidenceTriggeredRefreshAudit,
  logClaimDocumentExtractionAttemptedAudit,
  logClaimDocumentExtractionFailedAudit,
  logClaimDocumentExtractionPartialAudit,
  logClaimDocumentExtractionSkippedAudit,
  logClaimDocumentExtractionSucceededAudit,
  logClaimDocumentMatchEvaluatedAudit,
  logClaimDocumentReprocessFailedAudit,
  logClaimDocumentReprocessedAudit,
  logClaimDocumentReprocessRequestedAudit
} from '../../../../../../../../lib/audit/intake-audit-log'
import {
  detectAndMatchUploadedDocument,
  resolveChoiceMatchAfterExtraction,
  type DocumentDetectionResult
} from '../../../../../../../../lib/claims/detect-uploaded-document'
import { extractUploadedDocumentData } from '../../../../../../../../lib/claims/extract-uploaded-document'
import {
  applyUploadedDocumentEvidence,
  mergeExtractedDataWithEvidenceApply
} from '../../../../../../../../lib/claims/apply-uploaded-document-evidence'
import { readClaimDocumentFile } from '../../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../../lib/prisma'
import { isClaimLockedForProcessing } from '../../../../../../../../lib/review/claim-lock'
import { enqueueReviewSummaryForClaim } from '../../../../../../../../lib/review/enqueue-review-summary'

type RouteContext = {
  params: Promise<{ id: string; documentId: string }>
}

function buildClaimDetailUrl(requestUrl: string, claimId: string, status: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('documentReprocess', status)
  return url
}

function getExtractedDataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getExtractedFieldCount(value: unknown): number {
  const record = getExtractedDataRecord(value)
  const keys = Object.keys(record).filter((entry) => !entry.startsWith('__'))
  return keys.length
}

function getEvidenceApplyRecord(value: unknown): Record<string, unknown> {
  const extracted = getExtractedDataRecord(value)
  const apply = extracted.__evidenceApply
  return getExtractedDataRecord(apply)
}

function toChoiceFallbackAuditInput(input: {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  choiceFallback: NonNullable<Awaited<ReturnType<typeof extractUploadedDocumentData>>['choiceContractFallback']>
}) {
  return {
    claimId: input.claimId,
    claimNumber: input.claimNumber,
    documentId: input.documentId,
    fileName: input.fileName,
    documentType: input.documentType,
    fallbackStatus: input.choiceFallback.status,
    attempted: input.choiceFallback.attempted,
    used: input.choiceFallback.used,
    method: input.choiceFallback.method,
    extractedAt: input.choiceFallback.extractedAt,
    filledFields: input.choiceFallback.filledFields,
    triggerReasons: input.choiceFallback.triggerReasons,
    confidence: input.choiceFallback.confidence,
    warnings: input.choiceFallback.warnings,
    failureReason: input.choiceFallback.failureReason
  } as const
}

function parseEvidenceApplyForAudit(value: unknown): {
  applyStatus: string
  appliedAt: string | null
  appliedFields: string[]
  skippedFields: string[]
  conflictFields: string[]
} {
  const record = getEvidenceApplyRecord(value)

  const applyStatus = typeof record.applyStatus === 'string' ? record.applyStatus : 'skipped'
  const appliedAt = typeof record.appliedAt === 'string' ? record.appliedAt : null
  const appliedFields = Array.isArray(record.appliedFields)
    ? record.appliedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const skippedFields = Array.isArray(record.skippedFields)
    ? record.skippedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const conflictFields = Array.isArray(record.conflictFields)
    ? record.conflictFields
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null
          }

          const field = (entry as Record<string, unknown>).field
          const reason = (entry as Record<string, unknown>).reason

          if (typeof field !== 'string') {
            return null
          }

          return typeof reason === 'string' ? `${field}:${reason}` : field
        })
        .filter((entry): entry is string => Boolean(entry))
    : []

  return {
    applyStatus,
    appliedAt,
    appliedFields,
    skippedFields,
    conflictFields
  }
}

function shouldTriggerSummaryRefresh(input: { applyStatus: string; appliedFields: string[] }): boolean {
  return (input.applyStatus === 'applied' || input.applyStatus === 'partial') && input.appliedFields.length > 0
}

function parseDetectionFailure(error: unknown): DocumentDetectionResult {
  return {
    documentType: 'unknown',
    matchStatus: 'pending',
    matchNotes:
      'Document parsing failed during reprocess. Match verification remains pending.',
    anchors: {
      vin: null,
      claimantName: null,
      mileage: null,
      contractDate: null,
      purchaseDate: null,
      agreementDate: null
    },
    processingStatus: 'pending'
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id: claimId, documentId } = await context.params

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      reviewDecision: true,
      vin: true,
      claimantName: true,
      vinDataResult: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claimId, 'not-found'), { status: 303 })
  }

  if (isClaimLockedForProcessing(claim)) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
      status: 303
    })
  }

  const document = await prisma.claimDocument.findFirst({
    where: {
      id: documentId,
      claimId: claim.id
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      fileSize: true,
      storageKey: true,
      processingStatus: true,
      documentType: true,
      matchStatus: true,
      extractionStatus: true,
      extractionWarnings: true,
      extractedData: true
    }
  })

  if (!document) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'missing-document'), { status: 303 })
  }

  await logClaimDocumentReprocessRequestedAudit({
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    documentId: document.id,
    fileName: document.fileName,
    requestedBy: 'admin_ui',
    previousProcessingStatus: document.processingStatus,
    previousDocumentType: document.documentType,
    previousMatchStatus: document.matchStatus,
    previousExtractionStatus: document.extractionStatus
  })

  let pdfBytes: Buffer

  try {
    const fileBuffer = await readClaimDocumentFile(document.storageKey)
    pdfBytes = Buffer.from(fileBuffer)
  } catch {
    await logClaimDocumentReprocessFailedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      errorMessage: 'Document file not found in storage during reprocess.'
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'file-unavailable'), { status: 303 })
  }

  let detectionResult: DocumentDetectionResult

  try {
    detectionResult = await detectAndMatchUploadedDocument({
      fileName: document.fileName,
      pdfBytes,
      claimVin: claim.vin,
      claimantName: claim.claimantName
    })
  } catch (error) {
    console.warn('[claim_document] reprocess detection failed; marking pending', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      error: error instanceof Error ? error.message : 'unknown_error'
    })

    detectionResult = parseDetectionFailure(error)
  }

  const extractionResult = await extractUploadedDocumentData({
    documentType: detectionResult.documentType,
    pdfBytes,
    fileName: document.fileName
  })

  const effectiveDocumentType = extractionResult.resolvedDocumentType
  let finalMatchStatus = detectionResult.matchStatus
  let finalMatchNotes = detectionResult.matchNotes
  let finalProcessingStatus = detectionResult.processingStatus
  let finalAnchors = detectionResult.anchors

  if (
    effectiveDocumentType === 'choice_contract' &&
    (detectionResult.matchStatus === 'pending' || detectionResult.matchStatus === 'possible_match')
  ) {
    const choiceResolution = resolveChoiceMatchAfterExtraction({
      initial: {
        matchStatus: detectionResult.matchStatus,
        matchNotes: detectionResult.matchNotes,
        processingStatus: detectionResult.processingStatus,
        anchors: detectionResult.anchors
      },
      extractionStatus: extractionResult.status,
      extractedData: extractionResult.extractedData,
      claimVin: claim.vin
    })

    finalMatchStatus = choiceResolution.matchStatus
    finalMatchNotes = choiceResolution.matchNotes
    finalProcessingStatus = choiceResolution.processingStatus
    finalAnchors = choiceResolution.anchors

    console.info('[claim_document] reprocess choice match resolution', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      initialMatchStatus: detectionResult.matchStatus,
      finalMatchStatus,
      resolutionReason: choiceResolution.resolutionReason,
      extractionStatus: extractionResult.status,
      usedFallbackAnchors: choiceResolution.usedFallbackAnchors,
      availableAnchors: choiceResolution.availableAnchors
    })
  }

  const evidenceApplyResult = applyUploadedDocumentEvidence({
    documentId: document.id,
    documentType: effectiveDocumentType,
    matchStatus: finalMatchStatus,
    extractionStatus: extractionResult.status,
    extractedData: extractionResult.extractedData,
    vinDataResult: claim.vinDataResult
  })

  const extractedDataWithApply = mergeExtractedDataWithEvidenceApply(
    extractionResult.extractedData,
    evidenceApplyResult
  )

  let transactionResult:
    | {
        shouldQueueRefresh: boolean
        evidenceApplyStatus: string
        updatedSummary: {
          processingStatus: string
          documentType: string | null
          matchStatus: string | null
          extractionStatus: string
          extractedFieldCount: number
          fileName: string
          documentId: string
        }
      }
    | null = null

  try {
    transactionResult = await prisma.$transaction(async (tx) => {
      if (evidenceApplyResult.didMutateClaimEvidence) {
        await tx.claim.update({
          where: { id: claim.id },
          data: {
            vinDataResult: evidenceApplyResult.nextVinDataResult as Prisma.InputJsonValue
          }
        })
      }

      const updatedDocument = await tx.claimDocument.update({
        where: { id: document.id },
        data: {
          documentType: effectiveDocumentType,
          matchStatus: finalMatchStatus,
          matchNotes: finalMatchNotes,
          parsedAnchors: finalAnchors,
          processingStatus: finalProcessingStatus,
          extractionStatus: extractionResult.status,
          extractedAt: new Date(extractionResult.extractedAt),
          extractedData: extractedDataWithApply as Prisma.InputJsonValue,
          extractionWarnings:
            extractionResult.warnings.length > 0
              ? (extractionResult.warnings as Prisma.InputJsonValue)
              : Prisma.JsonNull
        },
        select: {
          id: true,
          fileName: true,
          processingStatus: true,
          documentType: true,
          matchStatus: true,
          extractionStatus: true,
          extractionWarnings: true,
          extractedData: true
        }
      })

      await logClaimDocumentClassifiedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown',
        processingStatus: updatedDocument.processingStatus
      })

      await logClaimDocumentMatchEvaluatedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        matchStatus: updatedDocument.matchStatus || 'pending',
        matchNotes: finalMatchNotes,
        anchors: finalAnchors
      })

      await logClaimDocumentExtractionAttemptedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown'
      })

      const choiceFallback = extractionResult.choiceContractFallback
      if (choiceFallback?.attempted) {
        const fallbackAuditInput = toChoiceFallbackAuditInput({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          choiceFallback
        })

        await logClaimDocumentChoiceFallbackAttemptedAudit({
          client: tx,
          ...fallbackAuditInput
        })

        if (choiceFallback.status === 'succeeded') {
          await logClaimDocumentChoiceFallbackSucceededAudit({
            client: tx,
            ...fallbackAuditInput
          })
        } else if (choiceFallback.status === 'partial') {
          await logClaimDocumentChoiceFallbackPartialAudit({
            client: tx,
            ...fallbackAuditInput
          })
        } else if (choiceFallback.status === 'failed') {
          await logClaimDocumentChoiceFallbackFailedAudit({
            client: tx,
            ...fallbackAuditInput
          })
        }
      }

      if (updatedDocument.extractionStatus === 'extracted') {
        await logClaimDocumentExtractionSucceededAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractedData: updatedDocument.extractedData as Prisma.InputJsonValue,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else if (updatedDocument.extractionStatus === 'partial') {
        await logClaimDocumentExtractionPartialAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractedData: updatedDocument.extractedData as Prisma.InputJsonValue,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else if (updatedDocument.extractionStatus === 'failed') {
        await logClaimDocumentExtractionFailedAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else {
        await logClaimDocumentExtractionSkippedAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      }

      const evidence = parseEvidenceApplyForAudit(updatedDocument.extractedData)

      const evidenceAuditInput = {
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown',
        applyStatus: evidence.applyStatus,
        appliedAt: evidence.appliedAt,
        appliedFields: evidence.appliedFields as Prisma.InputJsonValue,
        skippedFields: evidence.skippedFields as Prisma.InputJsonValue,
        conflictFields: evidence.conflictFields as Prisma.InputJsonValue
      }

      if (evidence.applyStatus === 'applied') {
        await logClaimDocumentEvidenceAppliedAudit(evidenceAuditInput)
      } else if (evidence.applyStatus === 'partial') {
        await logClaimDocumentEvidencePartiallyAppliedAudit(evidenceAuditInput)
      } else if (evidence.applyStatus === 'conflict') {
        await logClaimDocumentEvidenceConflictDetectedAudit(evidenceAuditInput)
      } else {
        await logClaimDocumentEvidenceSkippedAudit(evidenceAuditInput)
      }

      return {
        shouldQueueRefresh: shouldTriggerSummaryRefresh(evidence),
        evidenceApplyStatus: evidence.applyStatus,
        updatedSummary: {
          processingStatus: updatedDocument.processingStatus,
          documentType: updatedDocument.documentType,
          matchStatus: updatedDocument.matchStatus,
          extractionStatus: updatedDocument.extractionStatus,
          extractedFieldCount: getExtractedFieldCount(updatedDocument.extractedData),
          fileName: updatedDocument.fileName,
          documentId: updatedDocument.id
        }
      }
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Document reprocess failed.'

    console.error('[claim_document] reprocess failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      error: errorMessage
    })

    await logClaimDocumentReprocessFailedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      errorMessage
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'failed'), { status: 303 })
  }

  if (!transactionResult) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'failed'), { status: 303 })
  }

  const { shouldQueueRefresh, evidenceApplyStatus, updatedSummary } = transactionResult

  let refreshResult: Awaited<ReturnType<typeof enqueueReviewSummaryForClaim>> | null = null

  if (shouldQueueRefresh) {
    try {
      refreshResult = await enqueueReviewSummaryForClaim(claim.id, 'document_evidence')
    } catch (error) {
      refreshResult = {
        enqueued: false,
        claimId: claim.id,
        reason: 'enqueue_failed'
      }

      console.error('[claim_document] reprocess refresh enqueue failed', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedSummary.documentId,
        error: error instanceof Error ? error.message : 'unknown_error'
      })
    }

    await logClaimDocumentEvidenceTriggeredRefreshAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: updatedSummary.documentId,
      fileName: updatedSummary.fileName,
      documentType: updatedSummary.documentType || 'unknown',
      applyStatus: evidenceApplyStatus,
      queueEnqueued: refreshResult.enqueued,
      queueReason: refreshResult.reason,
      queueName: refreshResult.queueName,
      jobName: refreshResult.jobName,
      jobId: refreshResult.jobId
    })
  }

  await logClaimDocumentReprocessedAudit({
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    documentId: updatedSummary.documentId,
    fileName: updatedSummary.fileName,
    processingStatus: updatedSummary.processingStatus,
    documentType: updatedSummary.documentType,
    matchStatus: updatedSummary.matchStatus,
    extractionStatus: updatedSummary.extractionStatus,
    applyStatus: evidenceApplyStatus,
    extractedFieldCount: updatedSummary.extractedFieldCount,
    refreshQueued: refreshResult?.enqueued ?? false,
    refreshReason: refreshResult?.reason ?? null
  })

  return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'reprocessed'), { status: 303 })
}
