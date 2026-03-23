import { NextResponse } from 'next/server'
import { logReviewDecisionChangedAudit } from '../../../../../../lib/audit/intake-audit-log'
import { prisma } from '../../../../../../lib/prisma'

type RouteContext = {
  params: Promise<{ id: string }>
}

const ALLOWED_DECISIONS = new Set(['NeedsReview', 'Approved', 'Denied'])
const REVIEW_DECISION_VERSION = 'v1'

function buildClaimDetailUrl(requestUrl: string, claimId: string, result: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('reviewDecision', result)
  return url
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  const formData = await request.formData()
  const decisionValue = formData.get('decision')
  const notesValue = formData.get('notes')
  const overrideValue = formData.get('override')
  const overrideReasonValue = formData.get('overrideReason')

  const decision = typeof decisionValue === 'string' ? decisionValue.trim() : ''
  const notes = typeof notesValue === 'string' ? notesValue.trim() : ''
  const overrideReason = typeof overrideReasonValue === 'string' ? overrideReasonValue.trim() : ''
  const overrideUsed = overrideValue === 'on' || overrideValue === 'true' || overrideValue === '1'

  if (!ALLOWED_DECISIONS.has(decision)) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid'), { status: 303 })
  }

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      reviewDecision: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  try {
    const reviewer = 'admin'

    await prisma.$transaction(async (tx) => {
      await tx.claim.update({
        where: { id: claim.id },
        data: {
          reviewDecision: decision,
          reviewDecisionSetAt: new Date(),
          reviewDecisionNotes: notes.length > 0 ? notes : null,
          reviewDecisionBy: reviewer,
          reviewDecisionVersion: REVIEW_DECISION_VERSION
        }
      })

      await logReviewDecisionChangedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        fromDecision: claim.reviewDecision,
        toDecision: decision,
        notes,
        reviewer,
        overrideUsed,
        overrideReason: overrideReason || null
      })
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'saved'), { status: 303 })
  } catch (error) {
    console.error('[ADMIN_REVIEW_DECISION] failed to save reviewer decision', {
      claimId: id,
      error
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'error'), { status: 303 })
  }
}
