type ClaimWithReviewDecision = {
  reviewDecision?: string | null
}

export function isFinalReviewDecision(decision: string | null | undefined): boolean {
  return decision === 'Approved' || decision === 'Denied'
}

export function isClaimLockedForProcessing(claim: ClaimWithReviewDecision | null | undefined): boolean {
  return isFinalReviewDecision(claim?.reviewDecision)
}
