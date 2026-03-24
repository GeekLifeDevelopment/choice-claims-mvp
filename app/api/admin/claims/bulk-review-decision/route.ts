import { NextResponse } from 'next/server'

const ALLOWED_DECISIONS = new Set(['NeedsReview', 'Approved', 'Denied'])

type DecisionResult = 'saved' | 'locked_final_decision' | 'error'

function getSafeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') {
    return '/admin/claims'
  }

  return value.startsWith('/admin/claims') ? value : '/admin/claims'
}

function buildReturnUrl(requestUrl: string, returnPath: string): URL {
  return new URL(returnPath, requestUrl)
}

function appendSummaryParams(
  url: URL,
  decision: string,
  attempted: number,
  saved: number,
  locked: number,
  failed: number
): URL {
  url.searchParams.set('bulkDecision', 'done')
  url.searchParams.set('bulkDecisionValue', decision)
  url.searchParams.set('bulkAttempted', String(attempted))
  url.searchParams.set('bulkSaved', String(saved))
  url.searchParams.set('bulkLocked', String(locked))
  url.searchParams.set('bulkFailed', String(failed))
  return url
}

async function callExistingDecisionRoute(request: Request, claimId: string, decision: string): Promise<DecisionResult> {
  const decisionUrl = new URL(`/api/admin/claims/${claimId}/review-decision`, request.url)
  const payload = new URLSearchParams({ decision })

  const response = await fetch(decisionUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: payload.toString(),
    redirect: 'manual'
  })

  const location = response.headers.get('location')

  if (!location) {
    return 'error'
  }

  const redirectUrl = new URL(location, request.url)
  const outcome = redirectUrl.searchParams.get('reviewDecision')

  if (outcome === 'saved') {
    return 'saved'
  }

  if (outcome === 'locked_final_decision') {
    return 'locked_final_decision'
  }

  return 'error'
}

export async function POST(request: Request) {
  const formData = await request.formData()
  const returnPath = getSafeReturnPath(formData.get('returnTo'))
  const decisionValue = formData.get('decision')

  if (typeof decisionValue !== 'string') {
    const redirectUrl = buildReturnUrl(request.url, returnPath)
    redirectUrl.searchParams.set('bulkDecision', 'invalid')
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  const decision = decisionValue.trim()
  if (!ALLOWED_DECISIONS.has(decision)) {
    const redirectUrl = buildReturnUrl(request.url, returnPath)
    redirectUrl.searchParams.set('bulkDecision', 'invalid')
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  const selectedClaimIds = Array.from(
    new Set(
      formData
        .getAll('claimIds')
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )

  if (selectedClaimIds.length === 0) {
    const redirectUrl = buildReturnUrl(request.url, returnPath)
    redirectUrl.searchParams.set('bulkDecision', 'no-selection')
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  let saved = 0
  let locked = 0
  let failed = 0

  for (const claimId of selectedClaimIds) {
    try {
      const outcome = await callExistingDecisionRoute(request, claimId, decision)

      if (outcome === 'saved') {
        saved += 1
      } else if (outcome === 'locked_final_decision') {
        locked += 1
      } else {
        failed += 1
      }
    } catch (error) {
      failed += 1
      console.error('[ADMIN_BULK_REVIEW_DECISION] failed to apply decision', {
        claimId,
        decision,
        error
      })
    }
  }

  const redirectUrl = appendSummaryParams(
    buildReturnUrl(request.url, returnPath),
    decision,
    selectedClaimIds.length,
    saved,
    locked,
    failed
  )

  return NextResponse.redirect(redirectUrl, { status: 303 })
}
