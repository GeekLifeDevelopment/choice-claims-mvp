import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ['duplicate_blocked', 'duplicate_replay_ignored', 'claim_created'] }
    },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: {
      createdAt: true,
      action: true,
      metadata: true
      ,
      claim: {
        select: {
          id: true,
          claimNumber: true,
          status: true
        }
      }
    }
  })

  const out = rows.map((r) => ({
    createdAt: r.createdAt.toISOString(),
    action: r.action,
    claimId: r.claim?.id ?? null,
    claimNumber: r.claim?.claimNumber ?? null,
    claimStatus: r.claim?.status ?? null,
    dedupeKey: r.metadata?.dedupeKey,
    source: r.metadata?.source,
    dedupeSource: r.metadata?.dedupeSource,
    cognitoPayloadId: r.metadata?.cognitoPayloadId,
    cognitoEntryNumber: r.metadata?.cognitoEntryNumber,
    claimantEmail: r.metadata?.claimantEmail,
    vin: r.metadata?.vin
  }))

  console.log(JSON.stringify(out, null, 2))
} finally {
  await prisma.$disconnect()
}
