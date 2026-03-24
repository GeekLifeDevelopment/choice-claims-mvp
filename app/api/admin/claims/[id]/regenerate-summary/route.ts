import { NextResponse } from 'next/server'
import { logReviewSummaryRegenerateQueuedAudit } from '../../../../../../lib/audit/intake-audit-log'
import { prisma } from '../../../../../../lib/prisma'
import { enqueueReviewSummaryForClaim, REVIEW_SUMMARY_STATUS } from '../../../../../../lib/review/enqueue-review-summary'
import { isClaimLockedForProcessing } from '../../../../../../lib/review/claim-lock'

type RouteContext = {
  params: Promise<{ id: string }>
}

function buildClaimDetailUrl(requestUrl: string, claimId: string, summaryRegenerate: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('summaryRegenerate', summaryRegenerate)
  return url
}

function mapIneligibleReasonToResult(reason: string | null): string {
  if (reason === 'locked_final_decision') {
    return 'locked_final_decision'
  }

  if (reason === 'not_ready_for_ai') {
    return 'invalid-status'
  }

  if (reason === 'missing_rule_evaluation') {
    return 'missing-rule-evaluation'
  }

  if (reason === 'already_queued') {
    return 'already-queued'
  }

  if (reason === 'enqueue_failed') {
    return 'enqueue-failed'
  }

  return 'error'
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  console.info('[summary] regenerate request received', {
    claimId: id
  })

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      reviewSummaryStatus: true
    }
  })

  if (!claim) {
    console.warn('[summary] regenerate claim not found', {
      claimId: id
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  if (isClaimLockedForProcessing(claim)) {
    console.warn('[summary] regenerate locked claim skipped', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision
    })

    console.warn('[ADMIN_SUMMARY_REGENERATE] blocked by final decision lock', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reason: 'locked_final_decision',
      reviewDecision: claim.reviewDecision
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
      status: 303
    })
  }

  const previousSummaryStatus = claim.reviewSummaryStatus ?? REVIEW_SUMMARY_STATUS.NotRequested

  try {
    const result = await enqueueReviewSummaryForClaim(claim.id, 'manual')

    if (!result.enqueued) {
      const mappedResult = mapIneligibleReasonToResult(result.reason)

      console.warn('[summary] regenerate skipped', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        reason: result.reason,
        mappedResult
      })

      console.warn('[ADMIN_SUMMARY_REGENERATE] not enqueued', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        reason: result.reason,
        mappedResult,
        status: claim.status,
        reviewSummaryStatus: claim.reviewSummaryStatus
      })

      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, mappedResult), {
        status: 303
      })
    }

    await logReviewSummaryRegenerateQueuedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: result.queueName ?? 'review-summary',
      jobName: result.jobName ?? 'generate-review-summary',
      jobId: result.jobId,
      source: 'manual',
      reason: 'manual_regenerate',
      previousSummaryStatus,
      newSummaryStatus: REVIEW_SUMMARY_STATUS.Queued,
      reviewerDecision: claim.reviewDecision ?? undefined
    })

    console.info('[summary] regenerate queued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: result.queueName,
      jobName: result.jobName,
      jobId: result.jobId
    })

    console.info('[ADMIN_SUMMARY_REGENERATE] summary regeneration queued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status,
      previousSummaryStatus,
      queueName: result.queueName,
      jobName: result.jobName,
      jobId: result.jobId
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'queued'), {
      status: 303
    })
  } catch (error) {
    console.error('[summary] regenerate failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error
    })

    console.error('[ADMIN_SUMMARY_REGENERATE] unexpected failure', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status,
      error
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'error'), {
      status: 303
    })
  }
}
