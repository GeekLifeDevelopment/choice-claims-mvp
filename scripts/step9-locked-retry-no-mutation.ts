import { prisma } from '../lib/prisma'

const CLAIM_ID = 'cmmzdw0i20000jv0911vg7u8r'

async function main() {
  const before = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      status: true,
      reviewDecision: true,
      vinLookupAttemptCount: true,
      vinLookupLastJobId: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      updatedAt: true
    }
  })

  if (!before) throw new Error('Claim not found before check')

  const response = await fetch(`http://localhost:3000/api/admin/claims/${CLAIM_ID}/retry-vin`, {
    method: 'POST'
  })

  const location = response.headers.get('location')

  const after = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      status: true,
      reviewDecision: true,
      vinLookupAttemptCount: true,
      vinLookupLastJobId: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      updatedAt: true
    }
  })

  if (!after) throw new Error('Claim not found after check')

  const changedKeys = Object.keys(before).filter((key) => {
    if (key === 'updatedAt') return false
    const a = (before as Record<string, unknown>)[key]
    const b = (after as Record<string, unknown>)[key]
    return JSON.stringify(a) !== JSON.stringify(b)
  })

  console.log(
    JSON.stringify(
      {
        responseStatus: response.status,
        responseLocation: location,
        before,
        after,
        changedKeys
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
