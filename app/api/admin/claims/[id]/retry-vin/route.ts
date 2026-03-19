import { NextResponse } from 'next/server'
import { logVinLookupEnqueuedAudit } from '../../../../../../lib/audit/intake-audit-log'
import { ClaimStatus } from '../../../../../../lib/domain/claims'
import { prisma } from '../../../../../../lib/prisma'
import { buildVinLookupJobPayload } from '../../../../../../lib/queue/build-vin-lookup-job'
import { enqueueVinLookupJob } from '../../../../../../lib/queue/enqueue-vin-lookup-job'

type RouteContext = {
  params: Promise<{ id: string }>
}

function buildClaimDetailUrl(requestUrl: string, claimId: string, retry: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('retry', retry)
  return url
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      vin: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  if (claim.status !== ClaimStatus.ProviderFailed) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'invalid-status'), {
      status: 303
    })
  }

  try {
    const source = claim.source ?? 'admin_retry'
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
        status: ClaimStatus.AwaitingVinData,
        vinLookupLastError: null,
        vinLookupLastFailedAt: null,
        vinLookupLastJobId: enqueued.jobId ?? null,
        vinLookupLastJobName: enqueued.jobName,
        vinLookupLastQueueName: enqueued.queueName
      }
    })

    await logVinLookupEnqueuedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId,
      source,
      vin: claim.vin ?? undefined
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
    console.error('[ADMIN_RETRY] failed to re-enqueue VIN lookup', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'enqueue-failed'), {
      status: 303
    })
  }
}
