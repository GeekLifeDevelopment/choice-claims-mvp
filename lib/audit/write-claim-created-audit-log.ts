import type { Prisma } from '@prisma/client'

type WriteClaimCreatedAuditLogInput = {
  claimId: string
  source: string
  claimNumber: string
  attachmentCount: number
}

export async function writeClaimCreatedAuditLog(
  transaction: Prisma.TransactionClient,
  input: WriteClaimCreatedAuditLogInput
) {
  return transaction.auditLog.create({
    data: {
      claimId: input.claimId,
      action: 'claim_created',
      metadata: {
        source: input.source,
        claimNumber: input.claimNumber,
        attachmentCount: input.attachmentCount
      }
    }
  })
}
