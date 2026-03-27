import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { ClaimStatus } from '../lib/domain/claims'
import { createClaimFromSubmission } from '../lib/claims/create-claim-from-submission'

loadEnv({ path: '.env.local' })
loadEnv()

const prisma = new PrismaClient()
const POLL_INTERVAL_MS = 4_000
const POLL_TIMEOUT_MS = 240_000

type Scenario = {
  label: string
  vin: string
  expectedProfile: 'newer' | 'older' | 'recall_candidate' | 'sparse_candidate' | 'inconsistent_candidate'
}

type ClaimSnapshot = {
  id: string
  claimNumber: string
  status: string
  vin: string | null
  vinDataProvider: string | null
  vinDataProviderResultMessage: string | null
  vinDataResult: unknown
  reviewRuleFlags: unknown
  reviewSummaryStatus: string | null
  reviewSummaryText: string | null
  reviewSummaryLastError: string | null
  reviewDecision: string | null
  updatedAt: Date
}

const SCENARIOS: Scenario[] = [
  {
    label: 'older-sedan-baseline',
    vin: '1HGCM82633A004352',
    expectedProfile: 'older'
  },
  {
    label: 'newer-ev-candidate',
    vin: '5YJ3E1EA7JF000317',
    expectedProfile: 'newer'
  },
  {
    label: 'older-performance-candidate',
    vin: '1M8GDM9AXKP042788',
    expectedProfile: 'older'
  },
  {
    label: 'recall-candidate',
    vin: '3N1AB7AP6KY215764',
    expectedProfile: 'recall_candidate'
  },
  {
    label: 'sparse-data-candidate',
    vin: 'JH4DA3340GS008451',
    expectedProfile: 'sparse_candidate'
  },
  {
    label: 'inconsistent-provider-candidate',
    vin: '1FTFW1ET1EKE57182',
    expectedProfile: 'inconsistent_candidate'
  }
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isFinalEnough(snapshot: ClaimSnapshot): boolean {
  if (snapshot.status === ClaimStatus.AwaitingVinData) {
    return false
  }

  if (snapshot.reviewSummaryStatus === 'Queued') {
    return false
  }

  return true
}

async function fetchClaimSnapshot(claimId: string): Promise<ClaimSnapshot | null> {
  return prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      vin: true,
      vinDataProvider: true,
      vinDataProviderResultMessage: true,
      vinDataResult: true,
      reviewRuleFlags: true,
      reviewSummaryStatus: true,
      reviewSummaryText: true,
      reviewSummaryLastError: true,
      reviewDecision: true,
      updatedAt: true
    }
  })
}

function buildProviderMetrics(vinDataResult: unknown) {
  const data = asRecord(vinDataResult)
  const recalls = asRecord(data.nhtsaRecalls)
  const title = asRecord(data.titleHistory)
  const service = asRecord(data.serviceHistory)
  const valuation = asRecord(data.valuation)

  const recallCount = asNumber(recalls.count)
  const titleEventCount = Array.isArray(title.events) ? title.events.length : 0
  const serviceEventCount = asNumber(service.eventCount) ?? (Array.isArray(service.events) ? service.events.length : 0)

  return {
    provider: asString(data.provider),
    year: asNumber(data.year),
    make: asString(data.make),
    model: asString(data.model),
    recallCount,
    recallsMessage: asString(recalls.message),
    titleSource: asString(title.source),
    titleEventCount,
    titleMessage: asString(title.message),
    serviceSource: asString(service.source),
    serviceEventCount,
    serviceMessage: asString(service.message),
    valuationSource: asString(valuation.source),
    estimatedValue: asNumber(valuation.estimatedValue),
    valuationMessage: asString(valuation.message)
  }
}

function buildGaps(metrics: ReturnType<typeof buildProviderMetrics>, snapshot: ClaimSnapshot): string[] {
  const gaps: string[] = []

  if (!metrics.provider) {
    gaps.push('missing_provider_name')
  }

  if (!metrics.year || !metrics.make || !metrics.model) {
    gaps.push('missing_core_decode_fields')
  }

  if (metrics.recallCount === null) {
    gaps.push('missing_recalls_count')
  }

  if (metrics.titleEventCount === 0) {
    gaps.push('no_title_events')
  }

  if (metrics.serviceEventCount === 0) {
    gaps.push('no_service_events')
  }

  if (metrics.estimatedValue === null) {
    gaps.push('missing_valuation_amount')
  }

  if (!snapshot.reviewSummaryText && snapshot.reviewSummaryStatus !== 'Failed') {
    gaps.push('missing_summary_text')
  }

  if (snapshot.reviewSummaryStatus === 'Failed') {
    gaps.push('summary_failed')
  }

  if (!Array.isArray(snapshot.reviewRuleFlags)) {
    gaps.push('missing_rule_flags')
  }

  return gaps
}

async function main() {
  const nowSeed = Date.now()
  const submittedClaims: Array<{
    scenario: Scenario
    claimId: string
    claimNumber: string
  }> = []

  for (let index = 0; index < SCENARIOS.length; index += 1) {
    const scenario = SCENARIOS[index]
    const email = `s10-ticket5-${nowSeed}-${index}@example.com`

    const result = await createClaimFromSubmission({
      status: ClaimStatus.Submitted,
      source: 's10_ticket5_real_vin_validation',
      submittedAt: new Date(),
      vin: scenario.vin,
      claimantName: `Sprint 10 Scenario ${index + 1}`,
      claimantEmail: email,
      claimantPhone: '(555) 010-1095',
      attachments: [
        {
          filename: `scenario-${index + 1}-repair-order.pdf`,
          mimeType: 'application/pdf',
          fileSize: 98_000 + index,
          sourceUrl: `https://example.com/s10-ticket5/scenario-${index + 1}-repair-order.pdf`
        }
      ],
      rawSubmissionPayload: {
        source: 's10_ticket5_real_vin_validation',
        scenario: scenario.label,
        expectedProfile: scenario.expectedProfile,
        vin: scenario.vin,
        seed: nowSeed,
        submittedBy: 'automation_script'
      }
    })

    if (!result.ok) {
      throw new Error(`Failed to create claim for ${scenario.label}: ${result.error} (${result.message})`)
    }

    if (result.duplicate) {
      throw new Error(`Unexpected duplicate claim for ${scenario.label}; dedupe key: ${result.dedupeKey}`)
    }

    submittedClaims.push({
      scenario,
      claimId: result.claim.id,
      claimNumber: result.claim.claimNumber
    })
  }

  const startedAt = Date.now()
  const pendingIds = new Set(submittedClaims.map((entry) => entry.claimId))
  const snapshots = new Map<string, ClaimSnapshot>()

  while (pendingIds.size > 0) {
    for (const claimId of Array.from(pendingIds)) {
      const snapshot = await fetchClaimSnapshot(claimId)
      if (!snapshot) {
        continue
      }

      snapshots.set(claimId, snapshot)

      if (isFinalEnough(snapshot)) {
        pendingIds.delete(claimId)
      }
    }

    if (pendingIds.size === 0) {
      break
    }

    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      break
    }

    await sleep(POLL_INTERVAL_MS)
  }

  const output = submittedClaims.map((entry) => {
    const snapshot = snapshots.get(entry.claimId)

    if (!snapshot) {
      return {
        scenario: entry.scenario.label,
        expectedProfile: entry.scenario.expectedProfile,
        vin: entry.scenario.vin,
        claimId: entry.claimId,
        claimNumber: entry.claimNumber,
        timedOut: true,
        gapTags: ['missing_claim_snapshot']
      }
    }

    const metrics = buildProviderMetrics(snapshot.vinDataResult)
    const gapTags = buildGaps(metrics, snapshot)

    return {
      scenario: entry.scenario.label,
      expectedProfile: entry.scenario.expectedProfile,
      vin: entry.scenario.vin,
      claimId: snapshot.id,
      claimNumber: snapshot.claimNumber,
      status: snapshot.status,
      reviewSummaryStatus: snapshot.reviewSummaryStatus,
      reviewDecision: snapshot.reviewDecision,
      summaryLength: snapshot.reviewSummaryText?.length ?? 0,
      providerMetrics: metrics,
      gapTags,
      vinDataProvider: snapshot.vinDataProvider,
      vinDataProviderResultMessage: snapshot.vinDataProviderResultMessage,
      reviewSummaryLastError: snapshot.reviewSummaryLastError,
      updatedAt: snapshot.updatedAt.toISOString()
    }
  })

  const aggregatedGapCounts: Record<string, number> = {}
  for (const result of output) {
    const tags = Array.isArray(result.gapTags) ? result.gapTags : []
    for (const tag of tags) {
      aggregatedGapCounts[tag] = (aggregatedGapCounts[tag] || 0) + 1
    }
  }

  console.log(
    JSON.stringify(
      {
        queuePrefix: process.env.QUEUE_PREFIX || null,
        scenariosSubmitted: submittedClaims.length,
        timedOutCount: output.filter((entry) => (entry as { timedOut?: boolean }).timedOut).length,
        aggregatedGapCounts,
        claims: output
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error('[s10-ticket5-real-vin-validation] failed', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
