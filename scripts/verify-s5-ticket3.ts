import { ClaimStatus } from '../lib/domain/claims'
import { prisma } from '../lib/prisma'

const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000'
const WORKER_WAIT_MS = Number(process.env.S5_VERIFY_WORKER_WAIT_MS ?? '45000')

type RetryableStatus = ClaimStatus.ProviderFailed | ClaimStatus.ProcessingError

type ScenarioResult = {
  name: string
  pass: boolean
  skipped?: boolean
  claimId?: string
  claimNumber?: string
  responseStatus?: number
  responseLocation?: string | null
  notes: string[]
}

type ClaimRow = {
  id: string
  claimNumber: string
  status: string
  reviewDecision: string | null
  updatedAt: Date
  vinLookupAttemptCount: number | null
}

function isLocked(decision: string | null): boolean {
  return decision === 'Approved' || decision === 'Denied'
}

function parseRetryCode(location: string | null): string | null {
  if (!location) {
    return null
  }

  try {
    const url = new URL(location, BASE_URL)
    return url.searchParams.get('retry')
  } catch {
    const marker = 'retry='
    const idx = location.indexOf(marker)
    return idx >= 0 ? location.slice(idx + marker.length).split('&')[0] : null
  }
}

async function postRetry(claimId: string): Promise<{ status: number; location: string | null; retryCode: string | null }> {
  const response = await fetch(`${BASE_URL}/api/admin/claims/${claimId}/retry-vin`, {
    method: 'POST',
    redirect: 'manual'
  })

  const location = response.headers.get('location')

  return {
    status: response.status,
    location,
    retryCode: parseRetryCode(location)
  }
}

async function getClaim(id: string): Promise<ClaimRow> {
  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true,
      updatedAt: true,
      vinLookupAttemptCount: true
    }
  })

  if (!claim) {
    throw new Error(`Claim not found: ${id}`)
  }

  return claim
}

async function getRequeueAuditsSince(claimId: string, since: Date) {
  return prisma.auditLog.findMany({
    where: {
      claimId,
      action: 'vin_lookup_requeued',
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      metadata: true
    }
  })
}

function getMetadataField(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }

  return (metadata as Record<string, unknown>)[key]
}

async function selectCandidates() {
  const retryables = await prisma.claim.findMany({
    where: {
      status: { in: [ClaimStatus.ProviderFailed, ClaimStatus.ProcessingError] },
      reviewDecision: { notIn: ['Approved', 'Denied'] }
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      claimNumber: true,
      status: true,
      reviewDecision: true
    }
  })

  const providerFailed = retryables.find((claim) => claim.status === ClaimStatus.ProviderFailed)
  const processingError = retryables.find((claim) => claim.status === ClaimStatus.ProcessingError)
  const needsReviewExisting = retryables.find((claim) => claim.reviewDecision === 'NeedsReview')

  const lockedApproved = await prisma.claim.findFirst({
    where: {
      status: { in: [ClaimStatus.ProviderFailed, ClaimStatus.ProcessingError] },
      reviewDecision: 'Approved'
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, claimNumber: true, status: true, reviewDecision: true }
  })

  const lockedDenied = await prisma.claim.findFirst({
    where: {
      status: { in: [ClaimStatus.ProviderFailed, ClaimStatus.ProcessingError] },
      reviewDecision: 'Denied'
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, claimNumber: true, status: true, reviewDecision: true }
  })

  return {
    retryables,
    providerFailed,
    processingError,
    needsReviewExisting,
    lockedApproved,
    lockedDenied
  }
}

async function waitForWorkerProgress(claimId: string, timeoutMs: number): Promise<ClaimRow | null> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const claim = await getClaim(claimId)

    if (claim.status !== ClaimStatus.AwaitingVinData) {
      return claim
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return null
}

function scenario(name: string, pass: boolean, notes: string[], extras: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    name,
    pass,
    notes,
    ...extras
  }
}

async function run() {
  const started = new Date()
  const results: ScenarioResult[] = []

  const candidates = await selectCandidates()

  const used = new Set<string>()
  const claimForProviderFailed = candidates.providerFailed
  if (claimForProviderFailed) {
    used.add(claimForProviderFailed.id)
  }

  const claimForProcessingError =
    candidates.processingError && !used.has(candidates.processingError.id)
      ? candidates.processingError
      : undefined
  if (claimForProcessingError) {
    used.add(claimForProcessingError.id)
  }

  let claimForNeedsReview =
    candidates.needsReviewExisting && !used.has(candidates.needsReviewExisting.id)
      ? candidates.needsReviewExisting
      : undefined

  if (claimForNeedsReview) {
    used.add(claimForNeedsReview.id)
  }

  const claimForDuplicate = candidates.retryables.find((claim) => !used.has(claim.id))
  if (claimForDuplicate) {
    used.add(claimForDuplicate.id)
  }

  if (!claimForProviderFailed) {
    results.push(
      scenario('ProviderFailed -> retry works', false, ['No unlocked ProviderFailed claim available'], { skipped: true })
    )
  } else {
    const before = await getClaim(claimForProviderFailed.id)
    const scenarioStart = new Date()
    const response = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)
    const lastAudit = audits[audits.length - 1]

    const pass =
      response.retryCode === 'queued' &&
      before.status === ClaimStatus.ProviderFailed &&
      after.status === ClaimStatus.AwaitingVinData &&
      audits.length >= 1 &&
      getMetadataField(lastAudit?.metadata, 'reason') === 'manual_retry' &&
      getMetadataField(lastAudit?.metadata, 'previousStatus') === ClaimStatus.ProviderFailed

    results.push(
      scenario(
        'ProviderFailed -> retry works',
        pass,
        [
          `before.status=${before.status}`,
          `after.status=${after.status}`,
          `retryCode=${String(response.retryCode)}`,
          `audit.count=${audits.length}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: response.status,
          responseLocation: response.location
        }
      )
    )
  }

  if (!claimForProcessingError) {
    results.push(
      scenario('ProcessingError -> retry works', false, ['No unlocked ProcessingError claim available'], { skipped: true })
    )
  } else {
    const before = await getClaim(claimForProcessingError.id)
    const scenarioStart = new Date()
    const response = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)
    const lastAudit = audits[audits.length - 1]

    const pass =
      response.retryCode === 'queued' &&
      before.status === ClaimStatus.ProcessingError &&
      after.status === ClaimStatus.AwaitingVinData &&
      audits.length >= 1 &&
      getMetadataField(lastAudit?.metadata, 'reason') === 'manual_retry' &&
      getMetadataField(lastAudit?.metadata, 'previousStatus') === ClaimStatus.ProcessingError

    results.push(
      scenario(
        'ProcessingError -> retry works',
        pass,
        [
          `before.status=${before.status}`,
          `after.status=${after.status}`,
          `retryCode=${String(response.retryCode)}`,
          `audit.count=${audits.length}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: response.status,
          responseLocation: response.location
        }
      )
    )
  }

  if (!candidates.lockedApproved) {
    results.push(
      scenario('Approved -> retry blocked', false, ['No locked Approved retryable claim available'], { skipped: true })
    )
  } else {
    const before = await getClaim(candidates.lockedApproved.id)
    const scenarioStart = new Date()
    const response = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)

    const pass =
      isLocked(before.reviewDecision) &&
      response.retryCode === 'locked_final_decision' &&
      before.status === after.status &&
      before.updatedAt.getTime() === after.updatedAt.getTime() &&
      audits.length === 0

    results.push(
      scenario(
        'Approved -> retry blocked',
        pass,
        [
          `before.reviewDecision=${String(before.reviewDecision)}`,
          `after.status=${after.status}`,
          `retryCode=${String(response.retryCode)}`,
          `updatedAt.unchanged=${String(before.updatedAt.getTime() === after.updatedAt.getTime())}`,
          `audit.count=${audits.length}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: response.status,
          responseLocation: response.location
        }
      )
    )
  }

  if (!candidates.lockedDenied) {
    results.push(
      scenario('Denied -> retry blocked', false, ['No locked Denied retryable claim available'], { skipped: true })
    )
  } else {
    const before = await getClaim(candidates.lockedDenied.id)
    const scenarioStart = new Date()
    const response = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)

    const pass =
      isLocked(before.reviewDecision) &&
      response.retryCode === 'locked_final_decision' &&
      before.status === after.status &&
      before.updatedAt.getTime() === after.updatedAt.getTime() &&
      audits.length === 0

    results.push(
      scenario(
        'Denied -> retry blocked',
        pass,
        [
          `before.reviewDecision=${String(before.reviewDecision)}`,
          `after.status=${after.status}`,
          `retryCode=${String(response.retryCode)}`,
          `updatedAt.unchanged=${String(before.updatedAt.getTime() === after.updatedAt.getTime())}`,
          `audit.count=${audits.length}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: response.status,
          responseLocation: response.location
        }
      )
    )
  }

  if (!claimForNeedsReview) {
    const fallback = candidates.retryables.find((claim) => !used.has(claim.id))
    if (fallback) {
      const original = await getClaim(fallback.id)
      await prisma.claim.update({
        where: { id: fallback.id },
        data: { reviewDecision: 'NeedsReview' }
      })
      claimForNeedsReview = {
        id: fallback.id,
        claimNumber: fallback.claimNumber,
        status: fallback.status,
        reviewDecision: 'NeedsReview'
      }

      // Restore after test scenario finishes.
      results.push(
        scenario('NeedsReview setup', true, [`Temporary setup on ${fallback.claimNumber}`], {
          claimId: fallback.id,
          claimNumber: fallback.claimNumber
        })
      )

      const before = await getClaim(fallback.id)
      const scenarioStart = new Date()
      const response = await postRetry(before.id)
      const after = await getClaim(before.id)
      const audits = await getRequeueAuditsSince(before.id, scenarioStart)
      const lastAudit = audits[audits.length - 1]

      const pass =
        before.reviewDecision === 'NeedsReview' &&
        response.retryCode === 'queued' &&
        after.status === ClaimStatus.AwaitingVinData &&
        audits.length >= 1 &&
        getMetadataField(lastAudit?.metadata, 'reviewerDecision') === 'NeedsReview'

      results.push(
        scenario(
          'NeedsReview -> retry works',
          pass,
          [
            `before.reviewDecision=${String(before.reviewDecision)}`,
            `after.status=${after.status}`,
            `retryCode=${String(response.retryCode)}`,
            `audit.count=${audits.length}`
          ],
          {
            claimId: before.id,
            claimNumber: before.claimNumber,
            responseStatus: response.status,
            responseLocation: response.location
          }
        )
      )

      await prisma.claim.update({
        where: { id: original.id },
        data: { reviewDecision: original.reviewDecision }
      })
    } else {
      results.push(
        scenario('NeedsReview -> retry works', false, ['No candidate available for NeedsReview scenario'], {
          skipped: true
        })
      )
    }
  } else {
    const before = await getClaim(claimForNeedsReview.id)
    const scenarioStart = new Date()
    const response = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)
    const lastAudit = audits[audits.length - 1]

    const pass =
      before.reviewDecision === 'NeedsReview' &&
      response.retryCode === 'queued' &&
      after.status === ClaimStatus.AwaitingVinData &&
      audits.length >= 1 &&
      getMetadataField(lastAudit?.metadata, 'reviewerDecision') === 'NeedsReview'

    results.push(
      scenario(
        'NeedsReview -> retry works',
        pass,
        [
          `before.reviewDecision=${String(before.reviewDecision)}`,
          `after.status=${after.status}`,
          `retryCode=${String(response.retryCode)}`,
          `audit.count=${audits.length}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: response.status,
          responseLocation: response.location
        }
      )
    )
  }

  if (!claimForDuplicate) {
    results.push(
      scenario('No duplicate jobs', false, ['No extra unlocked retryable claim available'], { skipped: true })
    )
  } else {
    const before = await getClaim(claimForDuplicate.id)
    const scenarioStart = new Date()
    const first = await postRetry(before.id)
    const second = await postRetry(before.id)
    const after = await getClaim(before.id)
    const audits = await getRequeueAuditsSince(before.id, scenarioStart)

    const pass =
      first.retryCode === 'queued' &&
      (second.retryCode === 'invalid-status' || second.retryCode === 'duplicate-blocked') &&
      audits.length === 1 &&
      after.status === ClaimStatus.AwaitingVinData

    results.push(
      scenario(
        'No duplicate jobs',
        pass,
        [
          `first.retryCode=${String(first.retryCode)}`,
          `second.retryCode=${String(second.retryCode)}`,
          `audit.count=${audits.length}`,
          `after.status=${after.status}`
        ],
        {
          claimId: before.id,
          claimNumber: before.claimNumber,
          responseStatus: second.status,
          responseLocation: second.location
        }
      )
    )
  }

  if (!claimForProcessingError) {
    results.push(
      scenario('Worker processes job', false, ['Skipped because ProcessingError scenario had no candidate'], {
        skipped: true
      })
    )
  } else {
    const finalState = await waitForWorkerProgress(claimForProcessingError.id, WORKER_WAIT_MS)
    const pass = Boolean(finalState)

    results.push(
      scenario(
        'Worker processes job',
        pass,
        finalState
          ? [
              `final.status=${finalState.status}`,
              `final.vinLookupAttemptCount=${String(finalState.vinLookupAttemptCount)}`
            ]
          : [`Claim stayed AwaitingVinData for ${WORKER_WAIT_MS}ms; ensure worker is running`],
        {
          claimId: claimForProcessingError.id,
          claimNumber: claimForProcessingError.claimNumber
        }
      )
    )
  }

  const nonSetupResults = results.filter((result) => result.name !== 'NeedsReview setup')
  const failed = nonSetupResults.filter((result) => !result.pass && !result.skipped)
  const skipped = nonSetupResults.filter((result) => result.skipped)
  const passed = nonSetupResults.filter((result) => result.pass)

  console.log(
    JSON.stringify(
      {
        startedAt: started,
        baseUrl: BASE_URL,
        workerWaitMs: WORKER_WAIT_MS,
        summary: {
          total: nonSetupResults.length,
          passed: passed.length,
          failed: failed.length,
          skipped: skipped.length
        },
        results
      },
      null,
      2
    )
  )

  if (failed.length > 0) {
    process.exitCode = 1
  }
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
