import { NextResponse } from 'next/server'
import { logReviewDecisionChangedAudit } from '../../../../../../lib/audit/intake-audit-log'
import { prisma } from '../../../../../../lib/prisma'
import { isClaimLockedForProcessing } from '../../../../../../lib/review/claim-lock'

type RouteContext = {
  params: Promise<{ id: string }>
}

const ALLOWED_DECISIONS = new Set(['NeedsReview', 'Approved', 'Denied'])
const REVIEW_DECISION_VERSION = 'v1'
const MAX_REVIEW_NOTES_LENGTH = 5000
const MAX_OVERRIDE_REASON_LENGTH = 1000

function buildClaimDetailUrl(requestUrl: string, claimId: string, result: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('reviewDecision', result)
  return url
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  console.info('[decision] request received', {
    claimId: id
  })

  const formData = await request.formData()
  const decisionValue = formData.get('decision')
  const notesValue = formData.get('notes')
  const overrideValue = formData.get('override')
  const overrideReasonValue = formData.get('overrideReason')

  if (typeof decisionValue !== 'string') {
    console.warn('[decision] invalid payload missing decision', {
      claimId: id
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid'), { status: 303 })
  }

  if (notesValue !== null && typeof notesValue !== 'string') {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid-notes'), { status: 303 })
  }

  if (overrideReasonValue !== null && typeof overrideReasonValue !== 'string') {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid-override-reason'), {
      status: 303
    })
  }

  const decision = decisionValue.trim()
  const notes = typeof notesValue === 'string' ? notesValue.trim() : ''
  const overrideReasonRaw = typeof overrideReasonValue === 'string' ? overrideReasonValue.trim() : ''
  const overrideUsed = overrideValue === 'on' || overrideValue === 'true' || overrideValue === '1'
  const overrideReason = overrideUsed ? overrideReasonRaw : ''

  if (!ALLOWED_DECISIONS.has(decision)) {
    console.warn('[decision] invalid decision value', {
      claimId: id,
      decision
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'invalid'), { status: 303 })
  }

  if (notes.length > MAX_REVIEW_NOTES_LENGTH) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'notes-too-long'), { status: 303 })
  }

  if (overrideReason.length > MAX_OVERRIDE_REASON_LENGTH) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'override-reason-too-long'), {
      status: 303
    })
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
    console.warn('[decision] claim not found', {
      claimId: id
    })
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  if (isClaimLockedForProcessing(claim)) {
    console.warn('[decision] locked claim skipped', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision
    })

    console.warn('[ADMIN_REVIEW_DECISION] blocked by final decision lock', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision,
      reason: 'locked_final_decision'
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
      status: 303
    })
  }

  try {
    const reviewer = 'admin'

    await prisma.$transaction(async (tx) => {
      const updated = await tx.claim.updateMany({
        where: {
          id: claim.id,
          OR: [{ reviewDecision: null }, { reviewDecision: 'NeedsReview' }]
        },
        data: {
          reviewDecision: decision,
          reviewDecisionSetAt: new Date(),
          reviewDecisionNotes: notes.length > 0 ? notes : null,
          reviewDecisionBy: reviewer,
          reviewDecisionVersion: REVIEW_DECISION_VERSION
        }
      })

      if (updated.count === 0) {
        throw new Error('claim_locked_final_decision')
      }

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

    console.info('[decision] claim updated', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      decision
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'saved'), { status: 303 })
  } catch (error) {
    if (error instanceof Error && error.message === 'claim_locked_final_decision') {
      console.warn('[ADMIN_REVIEW_DECISION] blocked by final decision lock during update', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        reason: 'locked_final_decision'
      })

      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'locked_final_decision'), {
        status: 303
      })
    }

    console.error('[decision] save failed', {
      claimId: id,
      decision,
      error
    })

    console.error('[ADMIN_REVIEW_DECISION] failed to save reviewer decision', {
      claimId: id,
      error
    })

    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'error'), { status: 303 })
  }
}
