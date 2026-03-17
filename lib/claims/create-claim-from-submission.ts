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

export async function createClaimFromSubmission(
  input: CreateClaimFromIntakeInput
): Promise<ClaimCreationResult> {
  for (let attempt = 1; attempt <= CLAIM_NUMBER_MAX_ATTEMPTS; attempt += 1) {
    const claimNumber = generateClaimNumber()

    try {
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

        if (input.attachments.length > 0) {
          await transaction.claimAttachment.createMany({
            data: input.attachments.map((attachment) => ({
              claimId: claim.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              storageKey: attachment.storageKey,
              fileSize: attachment.fileSize,
              uploadedAt: new Date()
            }))
          })
        }

        await writeClaimCreatedAuditLog(transaction, {
          claimId: claim.id,
          source: input.source,
          claimNumber: claim.claimNumber,
          attachmentCount: input.attachments.length
        })

        return claim
      })

      return {
        ok: true,
        claim: createdClaim
      }
    } catch (error) {
      if (isClaimNumberUniqueViolation(error) && attempt < CLAIM_NUMBER_MAX_ATTEMPTS) {
        continue
      }

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
