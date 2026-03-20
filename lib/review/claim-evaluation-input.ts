import { prisma } from '../prisma'
import {
  buildClaimReviewSnapshot,
  type ClaimReviewSnapshot,
  type ClaimReviewSnapshotInput
} from './claim-review-snapshot'

export type ClaimEvaluationInput = {
  snapshot: ClaimReviewSnapshot
  generatedAt: string
  readiness: {
    isReadyForRules: boolean
    isReadyForAI: boolean
    reasons: string[]
  }
}

function buildReadiness(snapshot: ClaimReviewSnapshot): ClaimEvaluationInput['readiness'] {
  const reasons: string[] = []

  if (!snapshot.vin) {
    reasons.push('missing_vin')
  }

  if (!snapshot.provider?.providerName) {
    reasons.push('provider_data_missing')
  }

  if (snapshot.status !== 'ReadyForAI') {
    reasons.push('claim_not_ready_for_ai')
  }

  return {
    // Rules can run on partial snapshots and decide outcomes from available data.
    isReadyForRules: true,
    // AI requires explicit ReadyForAI status. This ticket intentionally keeps this lightweight.
    isReadyForAI: snapshot.status === 'ReadyForAI',
    reasons
  }
}

// Usage example for future pipeline tickets:
// const input = await getClaimEvaluationInput(claimId)
// runClaimRules(input)
// generateAiSummary(input)
export function buildClaimEvaluationInput(claim: ClaimReviewSnapshotInput): ClaimEvaluationInput {
  const snapshot = buildClaimReviewSnapshot(claim)

  return {
    snapshot,
    generatedAt: new Date().toISOString(),
    readiness: buildReadiness(snapshot)
  }
}

export async function getClaimEvaluationInput(claimId: string): Promise<ClaimEvaluationInput | null> {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      vin: true,
      claimantName: true,
      claimantEmail: true,
      claimantPhone: true,
      vinDataResult: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      vinLookupAttemptCount: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      attachments: {
        select: {
          filename: true,
          mimeType: true
        }
      }
    }
  })

  if (!claim) {
    return null
  }

  return buildClaimEvaluationInput(claim)
}
