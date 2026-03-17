import { Prisma } from '@prisma/client'
import type { CreateClaimFromIntakeInput } from '../domain/claims'
import { prisma } from '../prisma'
import { writeClaimCreatedAuditLog } from '../audit/write-claim-created-audit-log'
import { generateClaimNumber } from './generate-claim-number'

const CLAIM_NUMBER_MAX_ATTEMPTS = 5

type ClaimCreationSuccess = {
  ok: true
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

export type ClaimCreationResult = ClaimCreationSuccess | ClaimCreationFailure

function isClaimNumberUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes('claimNumber')
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

export async function createClaimFromSubmission(
  input: CreateClaimFromIntakeInput
): Promise<ClaimCreationResult> {
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
        claim: createdClaim
      }
    } catch (error) {
      if (isClaimNumberUniqueViolation(error) && attempt < CLAIM_NUMBER_MAX_ATTEMPTS) {
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
