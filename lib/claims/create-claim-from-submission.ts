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

async function getExistingClaimByDedupeKey(dedupeKey: string): Promise<ClaimSummary | null> {
  return prisma.claim.findUnique({
    where: { dedupeKey },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      createdAt: true,
      rawSubmissionPayload: true
    }
  })
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

  return {
    ok: true,
    duplicate: true,
    dedupeKey: input.dedupeKey,
    message: 'Duplicate submission detected',
    claim: input.existingClaim
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

        logClaimPersistence('claim status updated after enqueue', {
          claimId: claimAfterEnqueue.id,
          claimNumber: claimAfterEnqueue.claimNumber,
          status: claimAfterEnqueue.status
        })
      } catch (error) {
        logClaimPersistenceError('claim status update failed after enqueue', {
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
              : 'Claim created and VIN lookup enqueued, but status update failed'
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
