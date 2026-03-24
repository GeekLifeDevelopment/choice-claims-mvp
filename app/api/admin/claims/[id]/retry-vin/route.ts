import { NextResponse } from 'next/server'
import { logVinLookupRequeuedAudit } from '../../../../../../lib/audit/intake-audit-log'
import { ClaimStatus } from '../../../../../../lib/domain/claims'
import { prisma } from '../../../../../../lib/prisma'
import { buildVinLookupJobPayload } from '../../../../../../lib/queue/build-vin-lookup-job'
import { enqueueVinLookupJob } from '../../../../../../lib/queue/enqueue-vin-lookup-job'
import { isClaimLockedForProcessing } from '../../../../../../lib/review/claim-lock'

type RouteContext = {
  params: Promise<{ id: string }>
}

const RETRYABLE_STATUSES = new Set<string>([
  ClaimStatus.Submitted,
  ClaimStatus.ProviderFailed,
  ClaimStatus.ProcessingError
])

function buildClaimDetailUrl(requestUrl: string, claimId: string, retry: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('retry', retry)
  return url
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  console.info('[retry] request received', {
    claimId: id
  })

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      source: true,
      vin: true
    }
  })

  if (!claim) {
    console.warn('[retry] claim not found', {
      claimId: id
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  if (isClaimLockedForProcessing(claim)) {
    console.warn('[retry] locked claim skipped', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision
    })

    console.warn('[ADMIN_RETRY] blocked by final decision lock', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reason: 'locked_final_decision',
      reviewDecision: claim.reviewDecision
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
      status: 303
    })
  }

  if (!RETRYABLE_STATUSES.has(claim.status)) {
    console.warn('[retry] invalid status skipped', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status
    })

    console.warn('[ADMIN_RETRY] blocked by non-retryable status', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'invalid-status'), {
      status: 303
    })
  }

  const previousStatus = claim.status
  const source = claim.source ?? 'admin_retry'
  const retryRequestedAt = new Date()

  const transitioned = await prisma.claim.updateMany({
    where: {
      id: claim.id,
      status: previousStatus
    },
    data: {
      status: ClaimStatus.AwaitingVinData,
      vinLookupLastError: null,
      vinLookupLastFailedAt: null,
      vinLookupLastJobId: null,
      vinLookupLastJobName: null,
      vinLookupLastQueueName: null,
      vinLookupRetryRequestedAt: retryRequestedAt,
      // Attempt count is reset at manual retry start to represent attempts for the current retry run.
      vinLookupAttemptCount: 0
    }
  })

  if (transitioned.count === 0) {
    console.warn('[retry] transition race skipped', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      previousStatus
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'duplicate-blocked'), {
      status: 303
    })
  }

  try {
    const payload = buildVinLookupJobPayload({
      claimId: claim.id,
      vin: claim.vin,
      source,
      claimNumber: claim.claimNumber
    })

    const enqueued = await enqueueVinLookupJob(payload)

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        vinLookupLastJobId: enqueued.jobId ?? null,
        vinLookupLastJobName: enqueued.jobName,
        vinLookupLastQueueName: enqueued.queueName
      }
    })

    await logVinLookupRequeuedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      previousStatus,
      newStatus: ClaimStatus.AwaitingVinData,
      reason: 'manual_retry',
      reviewerDecision: claim.reviewDecision ?? undefined,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId,
      source,
      vin: claim.vin ?? undefined
    })

    console.info('[retry] vin lookup queued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId
    })

    console.info('[ADMIN_RETRY] VIN lookup re-enqueued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'queued'), { status: 303 })
  } catch (error) {
    await prisma.claim.updateMany({
      where: {
        id: claim.id,
        status: ClaimStatus.AwaitingVinData
      },
      data: {
        status: previousStatus,
        vinLookupLastError: 'Manual retry enqueue failed',
        vinLookupLastFailedAt: new Date()
      }
    })

    console.error('[ADMIN_RETRY] failed to re-enqueue VIN lookup', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error
    })

    console.error('[retry] enqueue failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'enqueue-failed'), {
      status: 303
    })
  }
}
