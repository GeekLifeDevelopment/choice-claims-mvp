import { Prisma } from '@prisma/client'
import type { CreateClaimFromIntakeInput } from '../domain/claims'
import { prisma } from '../prisma'
import { writeClaimCreatedAuditLog } from '../audit/write-claim-created-audit-log'
import { buildDedupeKey } from './build-dedupe-key'
import { generateClaimNumber } from './generate-claim-number'

const CLAIM_NUMBER_MAX_ATTEMPTS = 5

type ClaimCreationSuccess = {
  ok: true
  duplicate: false
  dedupeKey: string
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
  error: 'claim_creation_failed'
  message: string
}

export type ClaimCreationResult = ClaimCreationSuccess | ClaimCreationDuplicate | ClaimCreationFailure

type ClaimSummary = {
  id: string
  claimNumber: string
  status: string
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
      status: true
    }
  })
}

async function writeDuplicateBlockedAuditLog(input: {
  claimId: string
  claimNumber: string
  dedupeKey: string
  source: string
  claimantEmail?: string
  vin?: string
}) {
  await prisma.auditLog.create({
    data: {
      claimId: input.claimId,
      action: 'duplicate_blocked',
      metadata: {
        dedupeKey: input.dedupeKey,
        claimNumber: input.claimNumber,
        source: input.source,
        claimantEmail: input.claimantEmail,
        vin: input.vin
      }
    }
  })
}

async function buildDuplicateResult(input: {
  existingClaim: ClaimSummary
  dedupeKey: string
  source: string
  claimantEmail?: string
  vin?: string
}): Promise<ClaimCreationDuplicate> {
  try {
    await writeDuplicateBlockedAuditLog({
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      dedupeKey: input.dedupeKey,
      source: input.source,
      claimantEmail: input.claimantEmail,
      vin: input.vin
    })
  } catch (error) {
    logClaimPersistenceError('failed to write duplicate_blocked audit log', {
      claimId: input.existingClaim.id,
      claimNumber: input.existingClaim.claimNumber,
      dedupeKey: input.dedupeKey,
      error
    })
  }

  logClaimPersistence('duplicate detected', {
    claimId: input.existingClaim.id,
    claimNumber: input.existingClaim.claimNumber,
    dedupeKey: input.dedupeKey
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
  const dedupeKey = buildDedupeKey(input)
  logClaimPersistence('dedupe key built', { dedupeKey })

  const existingClaim = await getExistingClaimByDedupeKey(dedupeKey)
  if (existingClaim) {
    return buildDuplicateResult({
      existingClaim,
      dedupeKey,
      source: input.source,
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

        await writeClaimCreatedAuditLog(transaction, {
          claimId: claim.id,
          source: input.source,
          claimNumber: claim.claimNumber,
          attachmentCount: input.attachments.length
        })

        logClaimPersistence('audit log created', {
          claimId: claim.id,
          action: 'claim_created'
        })

        return claim
      })

      logClaimPersistence('transaction committed', {
        claimId: createdClaim.id,
        claimNumber: createdClaim.claimNumber
      })

      return {
        ok: true,
        duplicate: false,
        dedupeKey,
        claim: createdClaim
      }
    } catch (error) {
      if (isUniqueViolationOnField(error, 'dedupeKey')) {
        const claimAfterRace = await getExistingClaimByDedupeKey(dedupeKey)

        if (claimAfterRace) {
          return buildDuplicateResult({
            existingClaim: claimAfterRace,
            dedupeKey,
            source: input.source,
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
