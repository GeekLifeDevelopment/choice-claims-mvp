import { prisma } from '../lib/prisma'
import { buildVinLookupJobPayload } from '../lib/queue/build-vin-lookup-job'
import { enqueueVinLookupJob } from '../lib/queue/enqueue-vin-lookup-job'

const CLAIM_ID = 'cmmzbxblv000sjv09qjf1ha8z'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const before = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      vin: true,
      vinLookupAttemptCount: true,
      vinLookupLastJobId: true,
      vinLookupLastJobName: true,
      vinLookupLastQueueName: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      reviewSummaryStatus: true,
      updatedAt: true
    }
  })

  if (!before) {
    throw new Error(`Claim not found: ${CLAIM_ID}`)
  }

  const payload = buildVinLookupJobPayload({
    claimId: before.id,
    claimNumber: before.claimNumber,
    vin: before.vin,
    source: 'step9_locked_worker_test'
  })

  const enqueued = await enqueueVinLookupJob(payload)

  await sleep(4000)

  const after = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      vin: true,
      vinLookupAttemptCount: true,
      vinLookupLastJobId: true,
      vinLookupLastJobName: true,
      vinLookupLastQueueName: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      reviewSummaryStatus: true,
      updatedAt: true
    }
  })

  if (!after) {
    throw new Error(`Claim missing after test: ${CLAIM_ID}`)
  }

  const changedKeys = Object.keys(before).filter((key) => {
    const b = (before as Record<string, unknown>)[key]
    const a = (after as Record<string, unknown>)[key]
    return JSON.stringify(a) !== JSON.stringify(b)
  })

  console.log(
    JSON.stringify(
      {
        enqueued,
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
