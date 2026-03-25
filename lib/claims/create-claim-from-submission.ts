import { Prisma } from '@prisma/client'
import { ClaimStatus, type CreateClaimFromIntakeInput } from '../domain/claims'
import { prisma } from '../prisma'
import {
  logClaimCreatedAudit,
  logDuplicateBlockedAudit,
  logDuplicateReplayIgnoredAudit,
  logVinLookupEnqueuedAudit
} from '../audit/intake-audit-log'
import { buildDedupeKeyDetails, type DedupeSource } from './build-dedupe-key'
import { generateClaimNumber } from './generate-claim-number'
import { buildVinLookupJobPayload } from '../queue/build-vin-lookup-job'
import { enqueueVinLookupJob } from '../queue/enqueue-vin-lookup-job'
import { evaluateAndStoreClaimRules } from '../review/evaluate-and-store-claim-rules'
import { enqueueReviewSummaryForClaim } from '../review/enqueue-review-summary'
import { isFeatureEnabled } from '../config/feature-flags'

const CLAIM_NUMBER_MAX_ATTEMPTS = 5
const COGNITO_REPLAY_WINDOW_MS = 2 * 60 * 1000

type ClaimCreationSuccess = {
  ok: true
  duplicate: false
  dedupeKey: string
  enqueued: {
    queueName: string
    jobName: string
    jobId?: string
  }
  claim: {
    id: string
    claimNumber: string
    status: string
  }
}

type ClaimCreationDuplicate = {
  ok: true
  duplicate: true
  dedupeKey: string
  message: 'Duplicate submission detected'
  claim: {
    id: string
    claimNumber: string
    status: string
  }
}

type ClaimCreationFailure = {
  ok: false
  error: 'claim_creation_failed' | 'vin_lookup_enqueue_failed' | 'claim_status_update_failed'
  message: string
}

export type ClaimCreationResult = ClaimCreationSuccess | ClaimCreationDuplicate | ClaimCreationFailure

type ClaimSummary = {
  id: string
  claimNumber: string
  status: string
  createdAt: Date
  vin?: string | null
  vinLookupLastJobId?: string | null
  vinLookupLastJobName?: string | null
  vinLookupLastQueueName?: string | null
  rawSubmissionPayload: unknown
}

type CognitoReplayIdentity = {
  cognitoPayloadId?: string
  cognitoEntryNumber?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return undefined
}

function asIdentifierString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  return undefined
}

function extractCognitoReplayIdentity(rawSubmissionPayload: unknown): CognitoReplayIdentity {
  const topLevel = asRecord(rawSubmissionPayload)
  const entry = asRecord(topLevel?.Entry)

  return {
    cognitoPayloadId: asIdentifierString(topLevel?.Id),
    cognitoEntryNumber: asIdentifierString(entry?.Number)
  }
}

function isUniqueViolationOnField(error: unknown, fieldName: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes(fieldName)
  )
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function logClaimPersistence(message: string, details?: unknown) {
  if (details !== undefined) {
    console.info(`[CLAIM_PERSISTENCE] ${message}`, details)
    return
  }

  console.info(`[CLAIM_PERSISTENCE] ${message}`)
}

function logClaimPersistenceError(message: string, details?: unknown) {
  if (details !== undefined) {
    console.error(`[CLAIM_PERSISTENCE] ${message}`, details)
    return
  }

  console.error(`[CLAIM_PERSISTENCE] ${message}`)
}

async function evaluateAndStoreClaimRulesBestEffort(claimId: string, context: string): Promise<void> {
  try {
    const evaluation = await evaluateAndStoreClaimRules(claimId)

    if (!evaluation) {
      logClaimPersistenceError('rule evaluation skipped; claim not found', {
        claimId,
        context
      })
      return
    }

    logClaimPersistence('rule evaluation persisted', {
      claimId,
      context,
      flagCount: evaluation.result.flags.length,
      evaluatedAt: evaluation.evaluatedAt,
      error: evaluation.error
    })
  } catch (error) {
    logClaimPersistenceError('rule evaluation persistence failed unexpectedly', {
      claimId,
      context,
      error
    })
  }
}

async function getExistingClaimByDedupeKey(dedupeKey: string): Promise<ClaimSummary | null> {
  return prisma.claim.findUnique({
    where: { dedupeKey },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      createdAt: true,
      vin: true,
      vinLookupLastJobId: true,
      vinLookupLastJobName: true,
      vinLookupLastQueueName: true,
      rawSubmissionPayload: true
    }
  })
}

async function attemptCognitoReplayRecovery(input: {
  existingClaim: ClaimSummary
  dedupeKey: string
  source: string
  vin?: string
}) {
  if (input.source.toLowerCase() !== 'cognito') {
    return null
  }

  if (input.existingClaim.status !== ClaimStatus.Submitted) {
    return null
  }

  if (
    input.existingClaim.vinLookupLastJobId ||
    input.existingClaim.vinLookupLastJobName ||
    input.existingClaim.vinLookupLastQueueName
  ) {
    return null
  }

  const transitioned = await prisma.claim.updateMany({
    where: {
      id: input.existingClaim.id,
      status: ClaimStatus.Submitted,
      vinLookupLastJobId: null,
      vinLookupLastJobName: null,
      vinLookupLastQueueName: null
    },
    data: {
      status: ClaimStatus.AwaitingVinData,
      vinLookupLastError: null,
      vinLookupLastFailedAt: null
    }
  })

  if (transitioned.count === 0) {
    logClaimPersistence('duplicate replay recovery skipped due state change', {
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber
    })
    return null
  }

  if (!isFeatureEnabled('enrichment')) {
    console.info('[feature] enrichment disabled')

    await prisma.claim.updateMany({
      where: {
        id: input.existingClaim.id,
        status: ClaimStatus.AwaitingVinData
      },
      data: {
        status: ClaimStatus.ReadyForAI,
        vinLookupLastError: null,
        vinLookupLastFailedAt: null,
        vinDataProviderResultMessage: 'enrichment_disabled'
      }
    })

    return {
      status: ClaimStatus.ReadyForAI,
      enqueued: {
        queueName: 'feature-disabled',
        jobName: 'lookup-vin-data',
        jobId: undefined
      }
    }
  }

  const vinLookupPayload = buildVinLookupJobPayload({
    claimId: input.existingClaim.id,
    vin: input.vin ?? input.existingClaim.vin ?? null,
    source: 'cognito_replay_recovery',
    dedupeKey: input.dedupeKey,
    claimNumber: input.existingClaim.claimNumber
  })

  try {
    const enqueueResult = await enqueueVinLookupJob(vinLookupPayload)

    await prisma.claim.update({
      where: { id: input.existingClaim.id },
      data: {
        vinLookupLastJobId: enqueueResult.jobId ?? null,
        vinLookupLastJobName: enqueueResult.jobName,
        vinLookupLastQueueName: enqueueResult.queueName
      }
    })

    const enqueueAuditResult = await logVinLookupEnqueuedAudit({
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      queueName: enqueueResult.queueName,
      jobName: enqueueResult.jobName,
      jobId: enqueueResult.jobId,
      source: 'cognito_replay_recovery',
      vin: input.vin ?? input.existingClaim.vin ?? undefined
    })

    if (!enqueueAuditResult.ok) {
      logClaimPersistenceError('failed to write replay recovery vin_lookup_enqueued audit log', {
        claimId: input.existingClaim.id,
        claimNumber: input.existingClaim.claimNumber,
        error: enqueueAuditResult.error
      })
    }

    logClaimPersistence('duplicate replay recovery enqueued vin lookup', {
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      queueName: enqueueResult.queueName,
      jobName: enqueueResult.jobName,
      jobId: enqueueResult.jobId
    })

    return {
      status: ClaimStatus.AwaitingVinData,
      enqueued: enqueueResult
    }
  } catch (error) {
    await prisma.claim.updateMany({
      where: {
        id: input.existingClaim.id,
        status: ClaimStatus.AwaitingVinData
      },
      data: {
        status: ClaimStatus.Submitted,
        vinLookupLastError:
          error instanceof Error
            ? `Replay recovery enqueue failed: ${error.message}`
            : 'Replay recovery enqueue failed',
        vinLookupLastFailedAt: new Date()
      }
    })

    logClaimPersistenceError('duplicate replay recovery enqueue failed', {
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      error
    })

    return null
  }
}

function isLikelyCognitoReplay(input: {
  source: string
  existingClaimCreatedAt: Date
  existingClaimRawSubmissionPayload: unknown
  incomingRawSubmissionPayload: unknown
}): boolean {
  if (input.source.toLowerCase() !== 'cognito') {
    return false
  }

  const existingIdentity = extractCognitoReplayIdentity(input.existingClaimRawSubmissionPayload)
  const incomingIdentity = extractCognitoReplayIdentity(input.incomingRawSubmissionPayload)

  // Prefer exact identity matching when available. This catches delayed retries too.
  if (
    existingIdentity.cognitoEntryNumber &&
    incomingIdentity.cognitoEntryNumber &&
    existingIdentity.cognitoEntryNumber === incomingIdentity.cognitoEntryNumber
  ) {
    return true
  }

  if (
    existingIdentity.cognitoPayloadId &&
    incomingIdentity.cognitoPayloadId &&
    existingIdentity.cognitoPayloadId === incomingIdentity.cognitoPayloadId
  ) {
    return true
  }

  return Date.now() - input.existingClaimCreatedAt.getTime() <= COGNITO_REPLAY_WINDOW_MS
}

async function buildDuplicateResult(input: {
  existingClaim: ClaimSummary
  dedupeKey: string
  dedupeSource: DedupeSource
  source: string
  rawSubmissionPayload: unknown
  claimantEmail?: string
  vin?: string
}): Promise<ClaimCreationDuplicate> {
  let claimForResponse = input.existingClaim

  const isReplay = isLikelyCognitoReplay({
    source: input.source,
    existingClaimCreatedAt: input.existingClaim.createdAt,
    existingClaimRawSubmissionPayload: input.existingClaim.rawSubmissionPayload,
    incomingRawSubmissionPayload: input.rawSubmissionPayload
  })

  const replayIdentity = extractCognitoReplayIdentity(input.rawSubmissionPayload)

  const auditResult = isReplay
    ? await logDuplicateReplayIgnoredAudit({
        claimId: input.existingClaim.id,
        claimNumber: input.existingClaim.claimNumber,
        dedupeKey: input.dedupeKey,
        dedupeSource: input.dedupeSource,
        cognitoPayloadId: replayIdentity.cognitoPayloadId,
        cognitoEntryNumber: replayIdentity.cognitoEntryNumber,
        source: input.source,
        claimantEmail: input.claimantEmail,
        vin: input.vin
      })
    : await logDuplicateBlockedAudit({
        claimId: input.existingClaim.id,
        claimNumber: input.existingClaim.claimNumber,
        dedupeKey: input.dedupeKey,
        dedupeSource: input.dedupeSource,
        cognitoPayloadId: replayIdentity.cognitoPayloadId,
        cognitoEntryNumber: replayIdentity.cognitoEntryNumber,
        source: input.source,
        claimantEmail: input.claimantEmail,
        vin: input.vin
      })

  if (!auditResult.ok) {
    logClaimPersistenceError('failed to write duplicate audit log', {
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      dedupeKey: input.dedupeKey,
      error: auditResult.error
    })
  } else {
    logClaimPersistence('audit log written', {
      action: isReplay ? 'duplicate_replay_ignored' : 'duplicate_blocked',
      claimNumber: input.existingClaim.claimNumber,
      auditLogId: auditResult.auditLogId
    })
  }

  logClaimPersistence('duplicate detected', {
    claimId: input.existingClaim.id,
    claimNumber: input.existingClaim.claimNumber,
    dedupeKey: input.dedupeKey,
    dedupeSource: input.dedupeSource,
    cognitoPayloadId: replayIdentity.cognitoPayloadId,
    cognitoEntryNumber: replayIdentity.cognitoEntryNumber
  })

  if (isReplay) {
    const recoveryResult = await attemptCognitoReplayRecovery({
      existingClaim: input.existingClaim,
      dedupeKey: input.dedupeKey,
      source: input.source,
      vin: input.vin
    })

    if (recoveryResult) {
      claimForResponse = {
        ...input.existingClaim,
        status: recoveryResult.status
      }
    }
  }

  await evaluateAndStoreClaimRulesBestEffort(input.existingClaim.id, 'duplicate_submission')

  return {
    ok: true,
    duplicate: true,
    dedupeKey: input.dedupeKey,
    message: 'Duplicate submission detected',
    claim: claimForResponse
  }
}

export async function createClaimFromSubmission(
  input: CreateClaimFromIntakeInput
): Promise<ClaimCreationResult> {
  const { dedupeKey, dedupeSource } = buildDedupeKeyDetails(input)
  logClaimPersistence('dedupe key built', { dedupeKey, dedupeSource })

  const existingClaim = await getExistingClaimByDedupeKey(dedupeKey)
  if (existingClaim) {
    logClaimPersistence('dedupe source used for duplicate check', {
      dedupeSource,
      dedupeKey,
      claimId: existingClaim.id,
      claimNumber: existingClaim.claimNumber
    })

    return buildDuplicateResult({
      existingClaim,
      dedupeKey,
      dedupeSource,
      source: input.source,
        rawSubmissionPayload: input.rawSubmissionPayload,
      claimantEmail: input.claimantEmail,
      vin: input.vin
    })
  }

  for (let attempt = 1; attempt <= CLAIM_NUMBER_MAX_ATTEMPTS; attempt += 1) {
    const claimNumber = generateClaimNumber()
    logClaimPersistence('generated claim number', { attempt, claimNumber })

    try {
      logClaimPersistence('starting transaction', {
        claimNumber,
        source: input.source,
        attachmentCount: input.attachments.length
      })

      const createdClaim = await prisma.$transaction(async (transaction) => {
        const claim = await transaction.claim.create({
          data: {
            claimNumber,
            status: input.status,
            source: input.source,
            vin: input.vin,
            claimantName: input.claimantName,
            claimantEmail: input.claimantEmail,
            claimantPhone: input.claimantPhone,
            dedupeKey,
            rawSubmissionPayload: toPrismaJsonValue(input.rawSubmissionPayload),
            submittedAt: input.submittedAt
          },
          select: {
            id: true,
            claimNumber: true,
            status: true
          }
        })

        logClaimPersistence('claim row created', {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: claim.status
        })

        if (input.attachments.length > 0) {
          const attachmentCreateResult = await transaction.claimAttachment.createMany({
            data: input.attachments.map((attachment) => ({
              claimId: claim.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              sourceUrl: attachment.sourceUrl,
              externalId: attachment.externalId,
              storageKey: attachment.storageKey,
              fileSize: attachment.fileSize,
              uploadedAt: new Date()
            }))
          })

          logClaimPersistence('attachment rows created', {
            claimId: claim.id,
            createdCount: attachmentCreateResult.count
          })
        } else {
          logClaimPersistence('attachment rows created', {
            claimId: claim.id,
            createdCount: 0
          })
        }

        const claimCreatedAuditResult = await logClaimCreatedAudit({
          client: transaction,
          claimId: claim.id,
          source: input.source,
          claimNumber: claim.claimNumber,
          attachmentCount: input.attachments.length,
          claimantEmail: input.claimantEmail,
          vin: input.vin,
          dedupeKey
        })

        if (!claimCreatedAuditResult.ok) {
          logClaimPersistenceError('failed to write claim_created audit log', {
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            dedupeKey,
            error: claimCreatedAuditResult.error
          })
        } else {
          logClaimPersistence('audit log written', {
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            action: 'claim_created',
            auditLogId: claimCreatedAuditResult.auditLogId
          })
        }

        return claim
      })

      logClaimPersistence('transaction committed', {
        claimId: createdClaim.id,
        claimNumber: createdClaim.claimNumber
      })

      const vinLookupPayload = buildVinLookupJobPayload({
        claimId: createdClaim.id,
        vin: input.vin ?? null,
        source: input.source,
        dedupeKey,
        claimNumber: createdClaim.claimNumber
      })

      if (!isFeatureEnabled('enrichment')) {
        console.info('[feature] enrichment disabled')

        const claimAfterSkip = await prisma.claim.update({
          where: { id: createdClaim.id },
          data: {
            status: ClaimStatus.ReadyForAI,
            vinLookupLastError: null,
            vinLookupLastFailedAt: null,
            vinDataProviderResultMessage: 'enrichment_disabled'
          },
          select: {
            id: true,
            claimNumber: true,
            status: true
          }
        })

        await evaluateAndStoreClaimRulesBestEffort(claimAfterSkip.id, 'claim_created_enrichment_disabled')

        try {
          await enqueueReviewSummaryForClaim(claimAfterSkip.id, 'rules_ready')
        } catch (summaryError) {
          logClaimPersistenceError('summary enqueue failed after enrichment-disabled claim creation', {
            claimId: claimAfterSkip.id,
            claimNumber: claimAfterSkip.claimNumber,
            error: summaryError
          })
        }

        return {
          ok: true,
          duplicate: false,
          dedupeKey,
          enqueued: {
            queueName: 'feature-disabled',
            jobName: 'lookup-vin-data',
            jobId: undefined
          },
          claim: claimAfterSkip
        }
      }

      let claimAfterEnqueue

      try {
        claimAfterEnqueue = await prisma.claim.update({
          where: { id: createdClaim.id },
          data: { status: ClaimStatus.AwaitingVinData },
          select: {
            id: true,
            claimNumber: true,
            status: true
          }
        })

        logClaimPersistence('claim status updated before enqueue', {
          claimId: claimAfterEnqueue.id,
          claimNumber: claimAfterEnqueue.claimNumber,
          status: claimAfterEnqueue.status
        })
      } catch (error) {
        logClaimPersistenceError('claim status update failed before enqueue', {
          claimId: createdClaim.id,
          claimNumber: createdClaim.claimNumber,
          dedupeKey,
          error
        })

        return {
          ok: false,
          error: 'claim_status_update_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Claim created, but status update failed before VIN lookup enqueue'
        }
      }

      let enqueueResult: Awaited<ReturnType<typeof enqueueVinLookupJob>>

      try {
        enqueueResult = await enqueueVinLookupJob(vinLookupPayload)

        logClaimPersistence('vin lookup enqueued', {
          claimId: createdClaim.id,
          claimNumber: createdClaim.claimNumber,
          dedupeSource,
          queueName: enqueueResult.queueName,
          jobName: enqueueResult.jobName,
          jobId: enqueueResult.jobId
        })
      } catch (error) {
        await prisma.claim.updateMany({
          where: {
            id: createdClaim.id,
            status: ClaimStatus.AwaitingVinData
          },
          data: {
            status: ClaimStatus.ProcessingError,
            vinLookupLastError:
              error instanceof Error ? error.message : 'VIN lookup enqueue failed during intake',
            vinLookupLastFailedAt: new Date()
          }
        })

        logClaimPersistenceError('vin lookup enqueue failed', {
          claimId: createdClaim.id,
          claimNumber: createdClaim.claimNumber,
          dedupeKey,
          error
        })

        return {
          ok: false,
          error: 'vin_lookup_enqueue_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Claim created, but VIN lookup job enqueue failed'
        }
      }

      const enqueueAuditResult = await logVinLookupEnqueuedAudit({
        claimId: claimAfterEnqueue.id,
        claimNumber: claimAfterEnqueue.claimNumber,
        queueName: enqueueResult.queueName,
        jobName: enqueueResult.jobName,
        jobId: enqueueResult.jobId,
        source: input.source,
        vin: input.vin
      })

      if (!enqueueAuditResult.ok) {
        logClaimPersistenceError('failed to write vin_lookup_enqueued audit log', {
          claimId: claimAfterEnqueue.id,
          claimNumber: claimAfterEnqueue.claimNumber,
          queueName: enqueueResult.queueName,
          jobName: enqueueResult.jobName,
          jobId: enqueueResult.jobId,
          error: enqueueAuditResult.error
        })
      } else {
        logClaimPersistence('audit log written', {
          action: 'vin_lookup_enqueued',
          claimId: claimAfterEnqueue.id,
          claimNumber: claimAfterEnqueue.claimNumber,
          auditLogId: enqueueAuditResult.auditLogId
        })
      }

      await evaluateAndStoreClaimRulesBestEffort(
        claimAfterEnqueue.id,
        'claim_created_and_enqueued'
      )

      return {
        ok: true,
        duplicate: false,
        dedupeKey,
        enqueued: {
          queueName: enqueueResult.queueName,
          jobName: enqueueResult.jobName,
          jobId: enqueueResult.jobId
        },
        claim: claimAfterEnqueue
      }
    } catch (error) {
      if (isUniqueViolationOnField(error, 'dedupeKey')) {
        const claimAfterRace = await getExistingClaimByDedupeKey(dedupeKey)

        if (claimAfterRace) {
          return buildDuplicateResult({
            existingClaim: claimAfterRace,
            dedupeKey,
            dedupeSource,
            source: input.source,
            rawSubmissionPayload: input.rawSubmissionPayload,
            claimantEmail: input.claimantEmail,
            vin: input.vin
          })
        }
      }

      if (isUniqueViolationOnField(error, 'claimNumber') && attempt < CLAIM_NUMBER_MAX_ATTEMPTS) {
        logClaimPersistence('claim number collision, retrying', {
          claimNumber,
          attempt
        })
        continue
      }

      logClaimPersistenceError('persistence failed', {
        claimNumber,
        attempt,
        error
      })

      const message =
        error instanceof Error
          ? error.message
          : 'Failed to create claim and related records from intake submission'

      return {
        ok: false,
        error: 'claim_creation_failed',
        message
      }
    }
  }

  return {
    ok: false,
    error: 'claim_creation_failed',
    message: 'Failed to generate a unique claim number after multiple attempts'
  }
}
