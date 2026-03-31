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
  logClaimDocumentUploadedAudit
} from '../audit/intake-audit-log'
import type { IntakeAttachmentMetadata } from '../domain/claims'
import {
  detectAndMatchUploadedDocument,
  resolveChoiceMatchAfterExtraction,
  type DocumentDetectionResult
} from './detect-uploaded-document'
import { extractUploadedDocumentData } from './extract-uploaded-document'
import { saveClaimDocumentFile } from './claim-document-storage'
import { prisma } from '../prisma'
import {
  applyUploadedDocumentEvidence,
  mergeExtractedDataWithEvidenceApply
} from './apply-uploaded-document-evidence'
import { enqueueReviewSummaryForClaim } from '../review/enqueue-review-summary'

type IngestCognitoAttachmentsInput = {
  claimId: string
  claimNumber: string
  claimVin?: string | null
  claimantName?: string | null
  attachments: IntakeAttachmentMetadata[]
}

function inferMimeType(input: { fileName: string; mimeType?: string }): string {
  const explicit = input.mimeType?.trim().toLowerCase()
  if (explicit && explicit.length > 0) {
    return explicit
  }

  const lower = input.fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.heic')) return 'image/heic'
  if (lower.endsWith('.heif')) return 'image/heif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

function isPdfLike(input: { fileName: string; mimeType: string; fileBytes: Buffer }): boolean {
  if (input.mimeType.includes('pdf')) {
    return true
  }

  if (input.fileName.toLowerCase().endsWith('.pdf')) {
    return true
  }

  return input.fileBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')
}

function getExtractedFieldCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0
  }

  return Object.keys(value as Record<string, unknown>).filter((entry) => !entry.startsWith('__')).length
}

function parseEvidenceApplyForAudit(value: unknown): {
  applyStatus: string
  appliedAt: string | null
  appliedFields: string[]
  skippedFields: string[]
  conflictFields: string[]
} {
  const extracted = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  const apply =
    extracted.__evidenceApply && typeof extracted.__evidenceApply === 'object' && !Array.isArray(extracted.__evidenceApply)
      ? (extracted.__evidenceApply as Record<string, unknown>)
      : {}

  const applyStatus = typeof apply.applyStatus === 'string' ? apply.applyStatus : 'skipped'
  const appliedAt = typeof apply.appliedAt === 'string' ? apply.appliedAt : null
  const appliedFields = Array.isArray(apply.appliedFields)
    ? apply.appliedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const skippedFields = Array.isArray(apply.skippedFields)
    ? apply.skippedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const conflictFields = Array.isArray(apply.conflictFields)
    ? apply.conflictFields
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

async function fetchAttachmentBytes(sourceUrl: string): Promise<Buffer> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(sourceUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`fetch_failed_${response.status}`)
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) {
      throw new Error('fetch_empty_file')
    }

    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

export async function ingestCognitoAttachmentsIntoClaimDocuments(
  input: IngestCognitoAttachmentsInput
): Promise<void> {
  if (input.attachments.length === 0) {
    return
  }

  const claimForEvidence = await prisma.claim.findUnique({
    where: { id: input.claimId },
    select: {
      id: true,
      vinDataResult: true
    }
  })

  let currentVinDataResult: unknown = claimForEvidence?.vinDataResult ?? null

  for (const attachment of input.attachments) {
    const fileName = attachment.filename || 'cognito-attachment'
    const mimeType = inferMimeType({ fileName, mimeType: attachment.mimeType })

    if (!attachment.sourceUrl) {
      console.info('[cognito_attachment] skipped (missing sourceUrl)', {
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        fileName,
        mimeType
      })
      continue
    }

    let fileBytes: Buffer

    try {
      fileBytes = await fetchAttachmentBytes(attachment.sourceUrl)
    } catch (error) {
      console.warn('[cognito_attachment] fetch failed', {
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        fileName,
        sourceUrl: attachment.sourceUrl,
        error: error instanceof Error ? error.message : 'unknown_error'
      })
      continue
    }

    const saved = await saveClaimDocumentFile({
      claimId: input.claimId,
      fileName,
      content: fileBytes
    })

    const createdDocument = await prisma.claimDocument.create({
      data: {
        claimId: input.claimId,
        fileName,
        mimeType,
        storageKey: saved.storageKey,
        fileSize: fileBytes.length,
        uploadedBy: 'cognito_form',
        processingStatus: 'uploaded',
        documentType: null,
        matchStatus: null,
        matchNotes: null,
        parsedAnchors: Prisma.JsonNull,
        extractionStatus: 'pending',
        extractedAt: null,
        extractedData: Prisma.JsonNull,
        extractionWarnings: Prisma.JsonNull
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        uploadedBy: true
      }
    })

    let detectionResult: DocumentDetectionResult
    const pdfLike = isPdfLike({ fileName, mimeType, fileBytes })

    if (pdfLike) {
      try {
        detectionResult = await detectAndMatchUploadedDocument({
          fileName,
          pdfBytes: fileBytes,
          claimVin: input.claimVin,
          claimantName: input.claimantName
        })
      } catch (error) {
        console.warn('[cognito_attachment] detection failed', {
          claimId: input.claimId,
          claimNumber: input.claimNumber,
          documentId: createdDocument.id,
          fileName,
          error: error instanceof Error ? error.message : 'unknown_error'
        })

        detectionResult = {
          documentType: 'unknown',
          matchStatus: 'pending',
          matchNotes: 'Document parsing failed. Match verification is pending.',
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
    } else {
      detectionResult = {
        documentType: 'unknown',
        matchStatus: 'pending',
        matchNotes: 'Non-PDF attachment queued for OCR/vision extraction.',
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

    const extractionResult = await extractUploadedDocumentData({
      documentType: detectionResult.documentType,
      fileBytes,
      mimeType,
      fileName,
      documentId: createdDocument.id,
      storageKey: saved.storageKey
    })

    const effectiveDocumentType = extractionResult.resolvedDocumentType
    let finalMatchStatus = detectionResult.matchStatus
    let finalMatchNotes = detectionResult.matchNotes
    let finalProcessingStatus = detectionResult.processingStatus
    let finalAnchors = detectionResult.anchors

    const shouldRunChoiceResolver =
      effectiveDocumentType === 'choice_contract' &&
      (detectionResult.matchStatus === 'pending' ||
        detectionResult.matchStatus === 'possible_match' ||
        detectionResult.matchStatus === 'no_match')

    if (shouldRunChoiceResolver) {
      const choiceResolution = resolveChoiceMatchAfterExtraction({
        initial: {
          matchStatus: detectionResult.matchStatus,
          matchNotes: detectionResult.matchNotes,
          processingStatus: detectionResult.processingStatus,
          anchors: detectionResult.anchors
        },
        extractionStatus: extractionResult.status,
        extractedData: extractionResult.extractedData,
        claimVin: input.claimVin
      })

      finalMatchStatus = choiceResolution.matchStatus
      finalMatchNotes = choiceResolution.matchNotes
      finalProcessingStatus = choiceResolution.processingStatus
      finalAnchors = choiceResolution.anchors
    }

    const latestClaimForEvidence = await prisma.claim.findUnique({
      where: { id: input.claimId },
      select: { vinDataResult: true }
    })

    const evidenceApplyResult = applyUploadedDocumentEvidence({
      documentId: createdDocument.id,
      source: 'cognito_form',
      documentType: effectiveDocumentType,
      matchStatus: finalMatchStatus,
      extractionStatus: extractionResult.status,
      extractedData: extractionResult.extractedData,
      vinDataResult: latestClaimForEvidence?.vinDataResult ?? currentVinDataResult
    })

    const extractedDataWithApply = mergeExtractedDataWithEvidenceApply(
      extractionResult.extractedData,
      evidenceApplyResult
    )

    if (evidenceApplyResult.didMutateClaimEvidence) {
      await prisma.claim.update({
        where: { id: input.claimId },
        data: {
          vinDataResult: evidenceApplyResult.nextVinDataResult as Prisma.InputJsonValue
        }
      })

      currentVinDataResult = evidenceApplyResult.nextVinDataResult
    }

    await prisma.claimDocument.update({
      where: { id: createdDocument.id },
      data: {
        documentType: effectiveDocumentType,
        matchStatus: finalMatchStatus,
        matchNotes: finalMatchNotes,
        parsedAnchors: finalAnchors as Prisma.InputJsonValue,
        processingStatus: finalProcessingStatus,
        extractionStatus: extractionResult.status,
        extractedAt: new Date(extractionResult.extractedAt),
        extractedData: extractedDataWithApply as Prisma.InputJsonValue,
        extractionWarnings:
          extractionResult.warnings.length > 0
            ? (extractionResult.warnings as Prisma.InputJsonValue)
            : Prisma.JsonNull
      }
    })

    await logClaimDocumentUploadedAudit({
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      mimeType,
      fileSize: fileBytes.length,
      uploadedBy: 'cognito_form',
      processingStatus: finalProcessingStatus,
      documentType: effectiveDocumentType,
      matchStatus: finalMatchStatus
    })

    await logClaimDocumentClassifiedAudit({
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      documentType: effectiveDocumentType,
      processingStatus: finalProcessingStatus
    })

    await logClaimDocumentMatchEvaluatedAudit({
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      matchStatus: finalMatchStatus,
      matchNotes: finalMatchNotes,
      anchors: finalAnchors as Prisma.InputJsonValue
    })

    await logClaimDocumentExtractionAttemptedAudit({
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      documentType: effectiveDocumentType
    })

    const choiceFallback = extractionResult.choiceContractFallback
    if (choiceFallback?.attempted) {
      const fallbackAuditInput = toChoiceFallbackAuditInput({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        choiceFallback
      })

      await logClaimDocumentChoiceFallbackAttemptedAudit(fallbackAuditInput)

      if (choiceFallback.status === 'succeeded') {
        await logClaimDocumentChoiceFallbackSucceededAudit(fallbackAuditInput)
      } else if (choiceFallback.status === 'partial') {
        await logClaimDocumentChoiceFallbackPartialAudit(fallbackAuditInput)
      } else if (choiceFallback.status === 'failed') {
        await logClaimDocumentChoiceFallbackFailedAudit(fallbackAuditInput)
      }
    }

    if (extractionResult.status === 'extracted') {
      await logClaimDocumentExtractionSucceededAudit({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        extractionStatus: extractionResult.status,
        extractedAt: extractionResult.extractedAt,
        extractedData: extractedDataWithApply as Prisma.InputJsonValue,
        extractionWarnings: extractionResult.warnings as Prisma.InputJsonValue
      })
    } else if (extractionResult.status === 'partial') {
      await logClaimDocumentExtractionPartialAudit({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        extractionStatus: extractionResult.status,
        extractedAt: extractionResult.extractedAt,
        extractedData: extractedDataWithApply as Prisma.InputJsonValue,
        extractionWarnings: extractionResult.warnings as Prisma.InputJsonValue
      })
    } else if (extractionResult.status === 'failed') {
      await logClaimDocumentExtractionFailedAudit({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        extractionStatus: extractionResult.status,
        extractedAt: extractionResult.extractedAt,
        extractionWarnings: extractionResult.warnings as Prisma.InputJsonValue
      })
    } else if (extractionResult.status === 'skipped') {
      await logClaimDocumentExtractionSkippedAudit({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        extractionStatus: extractionResult.status,
        extractedAt: extractionResult.extractedAt,
        extractionWarnings: extractionResult.warnings as Prisma.InputJsonValue
      })
    }

    const evidence = parseEvidenceApplyForAudit(extractedDataWithApply)

    const evidenceAuditInput = {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      documentType: effectiveDocumentType,
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

    if (shouldTriggerSummaryRefresh(evidence)) {
      const refreshResult = await enqueueReviewSummaryForClaim(input.claimId, 'document_evidence')

      await logClaimDocumentEvidenceTriggeredRefreshAudit({
        claimId: input.claimId,
        claimNumber: input.claimNumber,
        documentId: createdDocument.id,
        fileName,
        documentType: effectiveDocumentType,
        applyStatus: evidence.applyStatus,
        queueEnqueued: refreshResult.enqueued,
        queueReason: refreshResult.reason,
        queueName: refreshResult.queueName,
        jobName: refreshResult.jobName,
        jobId: refreshResult.jobId
      })
    }

    console.info('[cognito_attachment] ingested into claim document pipeline', {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: createdDocument.id,
      fileName,
      mimeType,
      extractedFieldCount: getExtractedFieldCount(extractedDataWithApply),
      extractionStatus: extractionResult.status,
      matchStatus: finalMatchStatus,
      applyStatus: evidence.applyStatus
    })
  }
}
