import { NextResponse } from 'next/server'
import { retryVinLookupForClaim } from '../../../../../../lib/claims/retry-vin-lookup-for-claim'

type RouteContext = {
  params: Promise<{ id: string }>
}

function buildRedirectUrl(request: Request, returnTo: string, retryResult: string): URL {
  const safeReturnTo = returnTo.startsWith('/admin/claims/') ? returnTo : '/admin/claims'
  const url = new URL(safeReturnTo, request.url)
  url.searchParams.set('retry', retryResult)
  return url
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  const formData = await request.formData()
  const returnToValue = formData.get('returnTo')
  const returnTo = typeof returnToValue === 'string' ? returnToValue : `/admin/claims/${id}`

  const result = await retryVinLookupForClaim(id)

  if (!result.ok) {
    if (result.code === 'status_not_retryable') {
      console.warn('[ADMIN_RETRY] retry blocked non-retryable status', {
        claimId: result.claimId,
        claimNumber: result.claimNumber,
        message: result.message
      })

      return NextResponse.redirect(buildRedirectUrl(request, returnTo, 'not_retryable'), {
        status: 303
      })
    }

    if (result.code === 'status_changed') {
      console.warn('[ADMIN_RETRY] retry blocked status changed', {
        claimId: result.claimId,
        claimNumber: result.claimNumber,
        message: result.message
      })

      return NextResponse.redirect(buildRedirectUrl(request, returnTo, 'status_changed'), {
        status: 303
      })
    }

    if (result.code === 'claim_not_found') {
      console.warn('[ADMIN_RETRY] retry blocked claim not found', {
        claimId: id,
        message: result.message
      })

      return NextResponse.redirect(buildRedirectUrl(request, '/admin/claims', 'claim_not_found'), {
        status: 303
      })
    }

    console.error('[ADMIN_RETRY] retry enqueue failed', {
      claimId: result.claimId,
      claimNumber: result.claimNumber,
      message: result.message
    })

    return NextResponse.redirect(buildRedirectUrl(request, returnTo, 'enqueue_failed'), {
      status: 303
    })
  }

  console.info('[ADMIN_RETRY] retry enqueued', {
    claimId: result.claimId,
    claimNumber: result.claimNumber,
    previousStatus: result.previousStatus,
    newStatus: result.newStatus,
    queueName: result.queueName,
    jobName: result.jobName,
    jobId: result.jobId
  })

  return NextResponse.redirect(buildRedirectUrl(request, returnTo, 'success'), {
    status: 303
  })
}
