import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const latestClaim = await prisma.claim.findFirst({
    where: { source: 'cognito' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      claimNumber: true,
      dedupeKey: true,
      createdAt: true,
    },
  })

  if (!latestClaim) {
    console.log(JSON.stringify({ message: 'no cognito claim found' }, null, 2))
    return
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      claimId: latestClaim.id,
      action: {
        in: ['claim_created', 'duplicate_blocked', 'duplicate_replay_ignored'],
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      action: true,
      createdAt: true,
      metadata: true,
    },
  })

  console.log(
    JSON.stringify(
      {
        claim: latestClaim,
        logs,
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
