import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
loadEnv()

type ResultRow = {
  claimId: string
  claimNumber: string
  status: string
  reviewSummaryStatus: string | null
  reviewSummaryEnqueuedAt: string | null
  reviewDecision: string | null
  enqueueResult: 'enqueued' | 'skipped' | 'error'
  reason: string | null
}

let prismaClient: { $disconnect: () => Promise<void> } | null = null

function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const entry = process.argv.find((arg) => arg.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : null
}

function parseNumberArg(name: string, fallback: number): number {
  const raw = parseArg(name)
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBooleanFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const { enqueueReviewSummaryForClaim } = await import('../lib/review/enqueue-review-summary')
  const prismaModule = await import('../lib/prisma')
  const prisma = prismaModule.prisma!
  if (!prisma) {
    throw new Error('Prisma client export is unavailable.')
  }
  prismaClient = prisma

  const days = parseNumberArg('days', 14)
  const staleMinutes = parseNumberArg('staleMinutes', 10)
  const limit = parseNumberArg('limit', 100)
  const dryRun = parseBooleanFlag('dryRun')

  const now = Date.now()
  const since = new Date(now - days * 24 * 60 * 60 * 1000)
  const staleBefore = new Date(now - staleMinutes * 60 * 1000)

  const candidates = await prisma.claim.findMany({
    where: {
      createdAt: { gte: since },
      status: 'ReadyForAI',
      reviewSummaryStatus: 'Queued',
      reviewSummaryGeneratedAt: null,
      OR: [
        { reviewDecision: null },
        {
          reviewDecision: {
            notIn: ['Approved', 'Denied']
          }
        }
      ],
      AND: [
        {
          OR: [
            { reviewSummaryEnqueuedAt: null },
            { reviewSummaryEnqueuedAt: { lte: staleBefore } }
          ]
        }
      ]
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewSummaryStatus: true,
      reviewSummaryEnqueuedAt: true,
      reviewDecision: true
    }
  })

  const rows: ResultRow[] = []
  let enqueued = 0
  let skipped = 0
  let errors = 0

  for (const claim of candidates) {
    if (dryRun) {
      rows.push({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        reviewSummaryStatus: claim.reviewSummaryStatus,
        reviewSummaryEnqueuedAt: claim.reviewSummaryEnqueuedAt
          ? claim.reviewSummaryEnqueuedAt.toISOString()
          : null,
        reviewDecision: claim.reviewDecision,
        enqueueResult: 'skipped',
        reason: 'dry_run'
      })
      skipped += 1
      continue
    }

    try {
      await prisma.claim.updateMany({
        where: {
          id: claim.id,
          reviewSummaryStatus: 'Queued'
        },
        data: {
          reviewSummaryStatus: 'Failed',
          reviewSummaryLastError: 'stale_job_requeue',
          reviewSummaryVersion: 'stale-requeue-v1'
        }
      })

      const result = await enqueueReviewSummaryForClaim(claim.id, 'manual')
      const outcome = result.enqueued ? 'enqueued' : 'skipped'
      rows.push({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        reviewSummaryStatus: claim.reviewSummaryStatus,
        reviewSummaryEnqueuedAt: claim.reviewSummaryEnqueuedAt
          ? claim.reviewSummaryEnqueuedAt.toISOString()
          : null,
        reviewDecision: claim.reviewDecision,
        enqueueResult: outcome,
        reason: result.reason
      })

      if (result.enqueued) {
        enqueued += 1
      } else {
        skipped += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error'
      rows.push({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        reviewSummaryStatus: claim.reviewSummaryStatus,
        reviewSummaryEnqueuedAt: claim.reviewSummaryEnqueuedAt
          ? claim.reviewSummaryEnqueuedAt.toISOString()
          : null,
        reviewDecision: claim.reviewDecision,
        enqueueResult: 'error',
        reason: message
      })
      errors += 1
    }
  }

  console.log(
    JSON.stringify(
      {
        days,
        staleMinutes,
        limit,
        dryRun,
        scanned: candidates.length,
        enqueued,
        skipped,
        errors,
        rows
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
    if (prismaClient) {
      await prismaClient.$disconnect()
    }
  })
