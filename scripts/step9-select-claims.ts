import { prisma } from '../lib/prisma'

async function main() {
  const rows = await prisma.claim.groupBy({
    by: ['status', 'reviewDecision'],
    _count: { _all: true }
  })

  console.log('GROUPS')
  console.log(JSON.stringify(rows, null, 2))

  const claims = await prisma.claim.findMany({
    where: {
      status: {
        in: ['ProviderFailed', 'ProcessingError', 'ReadyForAI']
      }
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      vin: true,
      reviewSummaryStatus: true,
      vinLookupLastError: true
    }
  })

  console.log('CLAIMS')
  console.log(JSON.stringify(claims, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
