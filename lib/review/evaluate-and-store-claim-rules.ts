import { Prisma } from '@prisma/client'
import { prisma } from '../prisma'
import { buildClaimEvaluationInput } from './claim-evaluation-input'
import { runClaimRules, type ClaimRuleResult } from './claim-rules'

const REVIEW_RULE_VERSION = 'sprint4-ticket4-v1'

const CLAIM_EVALUATION_SELECT = {
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
} satisfies Prisma.ClaimSelect

type ClaimEvaluationRecord = Prisma.ClaimGetPayload<{ select: typeof CLAIM_EVALUATION_SELECT }>

export type EvaluateAndStoreClaimRulesResult = {
  claimId: string
  evaluatedAt: string
  version: string
  result: ClaimRuleResult
  error: string | null
}

async function loadClaimForEvaluation(claimId: string): Promise<ClaimEvaluationRecord | null> {
  return prisma.claim.findUnique({
    where: { id: claimId },
    select: CLAIM_EVALUATION_SELECT
  })
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Failed to evaluate deterministic review rules.'
}

export async function evaluateAndStoreClaimRules(
  claimId: string
): Promise<EvaluateAndStoreClaimRulesResult | null> {
  const claim = await loadClaimForEvaluation(claimId)
  if (!claim) {
    return null
  }

  const evaluatedAt = new Date()

  try {
    const input = buildClaimEvaluationInput(claim)
    const result = runClaimRules(input)

    await prisma.claim.update({
      where: { id: claimId },
      data: {
        reviewRuleFlags: result.flags as Prisma.InputJsonValue,
        reviewRuleEvaluatedAt: evaluatedAt,
        reviewRuleVersion: REVIEW_RULE_VERSION,
        reviewRuleLastError: null
      }
    })

    return {
      claimId,
      evaluatedAt: evaluatedAt.toISOString(),
      version: REVIEW_RULE_VERSION,
      result,
      error: null
    }
  } catch (error) {
    const message = toErrorMessage(error)

    await prisma.claim.update({
      where: { id: claimId },
      data: {
        reviewRuleFlags: [] as Prisma.InputJsonValue,
        reviewRuleEvaluatedAt: evaluatedAt,
        reviewRuleVersion: REVIEW_RULE_VERSION,
        reviewRuleLastError: message
      }
    })

    return {
      claimId,
      evaluatedAt: evaluatedAt.toISOString(),
      version: REVIEW_RULE_VERSION,
      result: { flags: [] },
      error: message
    }
  }
}
