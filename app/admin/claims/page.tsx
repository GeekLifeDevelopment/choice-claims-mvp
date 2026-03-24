import Link from 'next/link'
import { Prisma } from '@prisma/client'
import { BulkReviewDecisionForm } from '../../../components/admin/BulkReviewDecisionForm'
import { ClaimStatus } from '../../../lib/domain/claims'
import { prisma } from '../../../lib/prisma'
import { isFinalReviewDecision } from '../../../lib/review/claim-lock'

export const dynamic = 'force-dynamic'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

const STATUS_FILTER_VALUES = [
  'all',
  ClaimStatus.Submitted,
  ClaimStatus.AwaitingVinData,
  ClaimStatus.ReadyForAI,
  ClaimStatus.ProviderFailed,
  ClaimStatus.ProcessingError
] as const

type StatusFilterValue = (typeof STATUS_FILTER_VALUES)[number]

const DECISION_FILTER_VALUES = ['all', 'Unset', 'NeedsReview', 'Approved', 'Denied'] as const
type DecisionFilterValue = (typeof DECISION_FILTER_VALUES)[number]

const SUMMARY_FILTER_VALUES = ['all', 'NotRequested', 'Queued', 'Generated', 'Failed'] as const
type SummaryFilterValue = (typeof SUMMARY_FILTER_VALUES)[number]

const LOCKED_FILTER_VALUES = ['all', 'true', 'false'] as const
type LockedFilterValue = (typeof LOCKED_FILTER_VALUES)[number]

const READY_FILTER_VALUES = ['all', 'true', 'false'] as const
type ReadyFilterValue = (typeof READY_FILTER_VALUES)[number]

const NEEDS_SUMMARY_FILTER_VALUES = ['all', 'true', 'false'] as const
type NeedsSummaryFilterValue = (typeof NEEDS_SUMMARY_FILTER_VALUES)[number]

const SORT_FILTER_VALUES = ['submitted_desc', 'submitted_asc', 'updated_desc'] as const
type SortFilterValue = (typeof SORT_FILTER_VALUES)[number]

const FINAL_REVIEW_DECISIONS = ['Approved', 'Denied'].filter((decision) => isFinalReviewDecision(decision))

function getStatusBadgeClassName(status: string): string {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

  if (status === ClaimStatus.ReadyForAI) {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === ClaimStatus.AwaitingVinData) {
    return `${base} border-amber-300 bg-amber-50 text-amber-800`
  }

  if (status === ClaimStatus.ProviderFailed || status === ClaimStatus.ProcessingError) {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function getSummaryBadgeClassName(status: string): string {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

  if (status === 'Generated') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === 'Queued') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (status === 'Failed') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function getDecisionBadgeClassName(decision: string): string {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

  if (decision === 'Approved') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (decision === 'Denied') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (decision === 'NeedsReview') {
    return `${base} border-amber-300 bg-amber-50 text-amber-800`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function truncate(value: string | null | undefined, maxLength = 48): string {
  if (!value) {
    return '—'
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

type PageProps = {
  searchParams: Promise<{
    status?: string
    decision?: string
    summary?: string
    locked?: string
    ready?: string
    needsSummary?: string
    sort?: string
    bulkDecision?: string
    bulkDecisionValue?: string
    bulkAttempted?: string
    bulkSaved?: string
    bulkLocked?: string
    bulkFailed?: string
  }>
}

const CLAIM_ROW_SELECT = {
  id: true,
  claimNumber: true,
  status: true,
  reviewDecision: true,
  reviewSummaryStatus: true,
  reviewRuleFlags: true,
  reviewRuleEvaluatedAt: true,
  reviewSummaryGeneratedAt: true,
  claimantName: true,
  vin: true,
  vinDataProvider: true,
  vinDataFetchedAt: true,
  vinDataResult: true,
  vinDataProviderResultCode: true,
  vinDataProviderResultMessage: true,
  vinLookupAttemptCount: true,
  vinLookupLastError: true,
  submittedAt: true,
  updatedAt: true,
  attachments: {
    select: {
      id: true,
      sourceUrl: true
    }
  }
} satisfies Prisma.ClaimSelect

type ClaimRow = Prisma.ClaimGetPayload<{ select: typeof CLAIM_ROW_SELECT }>

function isValidFilterValue<T extends readonly string[]>(value: string | undefined, allowed: T): value is T[number] {
  return Boolean(value && allowed.includes(value as T[number]))
}

function buildClaimsUrl(
  selectedStatus: StatusFilterValue,
  selectedDecision: DecisionFilterValue,
  selectedSummary: SummaryFilterValue,
  selectedLocked: LockedFilterValue,
  selectedReady: ReadyFilterValue,
  selectedNeedsSummary: NeedsSummaryFilterValue,
  selectedSort: SortFilterValue,
  patch?: Partial<{
    status: StatusFilterValue
    decision: DecisionFilterValue
    summary: SummaryFilterValue
    locked: LockedFilterValue
    ready: ReadyFilterValue
    needsSummary: NeedsSummaryFilterValue
    sort: SortFilterValue
  }>
): string {
  const nextStatus = patch?.status ?? selectedStatus
  const nextDecision = patch?.decision ?? selectedDecision
  const nextSummary = patch?.summary ?? selectedSummary
  const nextLocked = patch?.locked ?? selectedLocked
  const nextReady = patch?.ready ?? selectedReady
  const nextNeedsSummary = patch?.needsSummary ?? selectedNeedsSummary
  const nextSort = patch?.sort ?? selectedSort

  const params = new URLSearchParams()

  if (nextStatus !== 'all') {
    params.set('status', nextStatus)
  }

  if (nextDecision !== 'all') {
    params.set('decision', nextDecision)
  }

  if (nextSummary !== 'all') {
    params.set('summary', nextSummary)
  }

  if (nextLocked !== 'all') {
    params.set('locked', nextLocked)
  }

  if (nextReady !== 'all') {
    params.set('ready', nextReady)
  }

  if (nextNeedsSummary !== 'all') {
    params.set('needsSummary', nextNeedsSummary)
  }

  if (nextSort !== 'submitted_desc') {
    params.set('sort', nextSort)
  }

  const query = params.toString()
  return query ? `/admin/claims?${query}` : '/admin/claims'
}

function buildClaimsExportUrl(
  selectedStatus: StatusFilterValue,
  selectedDecision: DecisionFilterValue,
  selectedSummary: SummaryFilterValue,
  selectedLocked: LockedFilterValue,
  selectedReady: ReadyFilterValue,
  selectedNeedsSummary: NeedsSummaryFilterValue,
  selectedSort: SortFilterValue
): string {
  const params = new URLSearchParams()

  if (selectedStatus !== 'all') {
    params.set('status', selectedStatus)
  }

  if (selectedDecision !== 'all') {
    params.set('decision', selectedDecision)
  }

  if (selectedSummary !== 'all') {
    params.set('summary', selectedSummary)
  }

  if (selectedLocked !== 'all') {
    params.set('locked', selectedLocked)
  }

  if (selectedReady !== 'all') {
    params.set('ready', selectedReady)
  }

  if (selectedNeedsSummary !== 'all') {
    params.set('needsSummary', selectedNeedsSummary)
  }

  if (selectedSort !== 'submitted_desc') {
    params.set('sort', selectedSort)
  }

  const query = params.toString()
  return query ? `/api/admin/claims/export?${query}` : '/api/admin/claims/export'
}

function getRuleFlagCount(flags: unknown): number {
  return Array.isArray(flags) ? flags.length : 0
}

function getSortOrder(sort: SortFilterValue): Prisma.ClaimOrderByWithRelationInput[] {
  if (sort === 'submitted_asc') {
    return [{ submittedAt: 'asc' }]
  }

  if (sort === 'updated_desc') {
    return [{ updatedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  return [{ submittedAt: 'desc' }]
}

function getBulkDecisionLabel(decision: string | undefined): string {
  if (decision === 'Approved') {
    return 'Approve'
  }

  if (decision === 'Denied') {
    return 'Reject'
  }

  if (decision === 'NeedsReview') {
    return 'NeedsReview'
  }

  return 'Update'
}

function toSafeCount(value: string | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function getBulkDecisionBannerMessage(params: Awaited<PageProps['searchParams']>): string | null {
  const status = params.bulkDecision

  if (status === 'invalid') {
    return 'Bulk action failed: invalid reviewer decision.'
  }

  if (status === 'no-selection') {
    return 'Bulk action skipped: select at least one claim.'
  }

  if (status !== 'done') {
    return null
  }

  const actionLabel = getBulkDecisionLabel(params.bulkDecisionValue)
  const attempted = toSafeCount(params.bulkAttempted)
  const saved = toSafeCount(params.bulkSaved)
  const locked = toSafeCount(params.bulkLocked)
  const failed = toSafeCount(params.bulkFailed)

  return `${actionLabel} complete: ${saved}/${attempted} updated. Locked skipped: ${locked}. Failed: ${failed}.`
}

function getBulkDecisionBannerClassName(params: Awaited<PageProps['searchParams']>): string {
  const status = params.bulkDecision
  const failed = toSafeCount(params.bulkFailed)

  if (status === 'done' && failed === 0) {
    return 'mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800'
  }

  if (status === 'done') {
    return 'mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900'
  }

  return 'mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800'
}

export default async function AdminClaimsPage({ searchParams }: PageProps) {
  const resolvedSearchParams = await searchParams
  const selectedStatus: StatusFilterValue = isValidFilterValue(
    resolvedSearchParams.status,
    STATUS_FILTER_VALUES
  )
    ? resolvedSearchParams.status
    : 'all'
  const selectedDecision: DecisionFilterValue = isValidFilterValue(
    resolvedSearchParams.decision,
    DECISION_FILTER_VALUES
  )
    ? resolvedSearchParams.decision
    : 'all'
  const selectedSummary: SummaryFilterValue = isValidFilterValue(
    resolvedSearchParams.summary,
    SUMMARY_FILTER_VALUES
  )
    ? resolvedSearchParams.summary
    : 'all'
  const selectedLocked: LockedFilterValue = isValidFilterValue(
    resolvedSearchParams.locked,
    LOCKED_FILTER_VALUES
  )
    ? resolvedSearchParams.locked
    : 'all'
  const selectedReady: ReadyFilterValue = isValidFilterValue(
    resolvedSearchParams.ready,
    READY_FILTER_VALUES
  )
    ? resolvedSearchParams.ready
    : 'all'
  const selectedNeedsSummary: NeedsSummaryFilterValue = isValidFilterValue(
    resolvedSearchParams.needsSummary,
    NEEDS_SUMMARY_FILTER_VALUES
  )
    ? resolvedSearchParams.needsSummary
    : 'all'
  const selectedSort: SortFilterValue = isValidFilterValue(resolvedSearchParams.sort, SORT_FILTER_VALUES)
    ? resolvedSearchParams.sort
    : 'submitted_desc'

  const whereClauses: Prisma.ClaimWhereInput[] = []

  if (selectedStatus !== 'all') {
    whereClauses.push({ status: selectedStatus })
  }

  if (selectedDecision === 'Unset') {
    whereClauses.push({ reviewDecision: null })
  } else if (selectedDecision !== 'all') {
    whereClauses.push({ reviewDecision: selectedDecision })
  }

  if (selectedSummary === 'NotRequested') {
    whereClauses.push({
      OR: [{ reviewSummaryStatus: null }, { reviewSummaryStatus: 'NotRequested' }]
    })
  } else if (selectedSummary !== 'all') {
    whereClauses.push({ reviewSummaryStatus: selectedSummary })
  }

  if (selectedLocked === 'true') {
    whereClauses.push({
      reviewDecision: {
        in: FINAL_REVIEW_DECISIONS
      }
    })
  } else if (selectedLocked === 'false') {
    whereClauses.push({
      OR: [{ reviewDecision: null }, { reviewDecision: { notIn: FINAL_REVIEW_DECISIONS } }]
    })
  }

  if (selectedReady === 'true') {
    whereClauses.push({
      AND: [
        { status: ClaimStatus.ReadyForAI },
        { reviewSummaryStatus: 'Generated' },
        { OR: [{ reviewDecision: null }, { reviewDecision: { notIn: FINAL_REVIEW_DECISIONS } }] }
      ]
    })
  } else if (selectedReady === 'false') {
    whereClauses.push({
      NOT: {
        AND: [
          { status: ClaimStatus.ReadyForAI },
          { reviewSummaryStatus: 'Generated' },
          { OR: [{ reviewDecision: null }, { reviewDecision: { notIn: FINAL_REVIEW_DECISIONS } }] }
        ]
      }
    })
  }

  if (selectedNeedsSummary === 'true') {
    whereClauses.push({
      AND: [
        { status: ClaimStatus.ReadyForAI },
        {
          OR: [
            { reviewSummaryStatus: null },
            { reviewSummaryStatus: 'NotRequested' },
            { reviewSummaryStatus: 'Failed' }
          ]
        },
        { OR: [{ reviewDecision: null }, { reviewDecision: { notIn: FINAL_REVIEW_DECISIONS } }] }
      ]
    })
  } else if (selectedNeedsSummary === 'false') {
    whereClauses.push({
      NOT: {
        AND: [
          { status: ClaimStatus.ReadyForAI },
          {
            OR: [
              { reviewSummaryStatus: null },
              { reviewSummaryStatus: 'NotRequested' },
              { reviewSummaryStatus: 'Failed' }
            ]
          },
          { OR: [{ reviewDecision: null }, { reviewDecision: { notIn: FINAL_REVIEW_DECISIONS } }] }
        ]
      }
    })
  }

  const where: Prisma.ClaimWhereInput | undefined =
    whereClauses.length > 0 ? { AND: whereClauses } : undefined

  const orderBy = getSortOrder(selectedSort)

  let dbError: string | null = null
  let claims: ClaimRow[] = []

  try {
    claims = await prisma.claim.findMany({
      where,
      orderBy,
      take: 50,
      select: CLAIM_ROW_SELECT
    })

    console.info('[ADMIN_CLAIMS] loaded claims from prisma', {
      count: claims.length,
      claimNumbers: claims.slice(0, 5).map((claim) => claim.claimNumber)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error'
    dbError = message

    console.error('[ADMIN_CLAIMS] failed to load claims from prisma', {
      selectedStatus,
      selectedDecision,
      selectedSummary,
      selectedSort,
      message
    })
  }

  const filterCount =
    (selectedStatus === 'all' ? 0 : 1) +
    (selectedDecision === 'all' ? 0 : 1) +
    (selectedSummary === 'all' ? 0 : 1) +
    (selectedLocked === 'all' ? 0 : 1) +
    (selectedReady === 'all' ? 0 : 1) +
    (selectedNeedsSummary === 'all' ? 0 : 1)

  const bulkDecisionBannerMessage = getBulkDecisionBannerMessage(resolvedSearchParams)
  const bulkDecisionBannerClassName = getBulkDecisionBannerClassName(resolvedSearchParams)
  const bulkFormReturnTo = buildClaimsUrl(
    selectedStatus,
    selectedDecision,
    selectedSummary,
    selectedLocked,
    selectedReady,
    selectedNeedsSummary,
    selectedSort
  )

  return (
    <section className="card">
      <h1 className="text-2xl">Admin — Claims</h1>
      <p className="mt-2 text-slate-700">Reviewer queue with server-side filtering and sorting controls.</p>

      <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Quick Filters:</span>
          <Link
            href={buildClaimsUrl('all', 'all', 'all', 'all', 'all', 'all', selectedSort)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100"
          >
            All
          </Link>
          <Link
            href={buildClaimsUrl('all', 'all', 'all', 'false', 'true', 'all', selectedSort)}
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 hover:bg-amber-100"
          >
            ReadyForReview
          </Link>
          <Link
            href={buildClaimsUrl('all', 'all', 'all', 'false', 'all', 'true', selectedSort)}
            className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-sky-900 hover:bg-sky-100"
          >
            NeedsSummary
          </Link>
          <Link
            href={buildClaimsUrl('all', 'all', 'all', 'true', 'all', 'all', selectedSort)}
            className="rounded-md border border-slate-400 bg-slate-100 px-2 py-1 text-slate-800 hover:bg-slate-200"
          >
            Locked
          </Link>
          <Link
            href={buildClaimsUrl('all', 'Approved', 'all', 'all', 'all', 'all', selectedSort)}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900 hover:bg-emerald-100"
          >
            Approved
          </Link>
          <Link
            href={buildClaimsUrl('all', 'Denied', 'all', 'all', 'all', 'all', selectedSort)}
            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-red-900 hover:bg-red-100"
          >
            Rejected
          </Link>
        </div>

        <form action="/admin/claims" method="get" className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Status</span>
            <select
              name="status"
              defaultValue={selectedStatus}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              {STATUS_FILTER_VALUES.map((status) => (
                <option key={status} value={status}>
                  {status === 'all' ? 'All' : status}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Decision</span>
            <select
              name="decision"
              defaultValue={selectedDecision}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              {DECISION_FILTER_VALUES.map((decision) => (
                <option key={decision} value={decision}>
                  {decision}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Summary</span>
            <select
              name="summary"
              defaultValue={selectedSummary}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              {SUMMARY_FILTER_VALUES.map((summary) => (
                <option key={summary} value={summary}>
                  {summary}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Locked</span>
            <select
              name="locked"
              defaultValue={selectedLocked}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="all">All</option>
              <option value="true">Locked only</option>
              <option value="false">Unlocked only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Ready For Review</span>
            <select
              name="ready"
              defaultValue={selectedReady}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="all">All</option>
              <option value="true">Ready only</option>
              <option value="false">Not ready only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Needs Summary</span>
            <select
              name="needsSummary"
              defaultValue={selectedNeedsSummary}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="all">All</option>
              <option value="true">Needs summary only</option>
              <option value="false">No summary needed only</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-slate-700">
            <span className="font-medium">Sort</span>
            <select
              name="sort"
              defaultValue={selectedSort}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="submitted_desc">Newest first</option>
              <option value="submitted_asc">Oldest first</option>
              <option value="updated_desc">Recently updated</option>
            </select>
          </label>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
            >
              Apply Filters
            </button>
            <Link
              href="/admin/claims"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Clear
            </Link>
          </div>
        </form>

        <p className="text-xs text-slate-600">
          Showing {claims.length} claims{filterCount > 0 ? ` with ${filterCount} active filters` : ''}.
        </p>

        <div className="pt-1">
          <a
            href={buildClaimsExportUrl(
              selectedStatus,
              selectedDecision,
              selectedSummary,
              selectedLocked,
              selectedReady,
              selectedNeedsSummary,
              selectedSort
            )}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          >
            Export CSV
          </a>
        </div>

        {!dbError && claims.length > 0 ? <BulkReviewDecisionForm returnTo={bulkFormReturnTo} /> : null}
      </div>

      {bulkDecisionBannerMessage ? <div className={bulkDecisionBannerClassName}>{bulkDecisionBannerMessage}</div> : null}

      {dbError ? (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Unable to load claims right now because the database is not reachable.
          <br />
          <span className="text-red-700">Details: {dbError}</span>
        </div>
      ) : null}

      {!dbError && claims.length === 0 ? (
        <p className="mt-4 text-slate-600">No claims match the current reviewer queue filters.</p>
      ) : !dbError ? (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 pr-2 font-medium">Select</th>
                <th className="py-2 pr-4 font-medium">Claim #</th>
                <th className="py-2 pr-4 font-medium">Submitted</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Review Decision</th>
                <th className="py-2 pr-4 font-medium">Summary</th>
                <th className="py-2 pr-4 font-medium">Rule Flags</th>
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">Claimant</th>
                <th className="py-2 pr-4 font-medium">VIN</th>
                <th className="py-2 pr-4 font-medium">Queue</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => {
                const normalizedResult = asRecord(claim.vinDataResult)
                const providerMake = getOptionalString(normalizedResult.make)
                const providerModel = getOptionalString(normalizedResult.model)
                const providerYear = getOptionalNumber(normalizedResult.year)
                const providerVehicleHint =
                  providerYear !== null || providerMake || providerModel
                    ? `${providerYear !== null ? `${providerYear} ` : ''}${providerMake ?? ''} ${providerModel ?? ''}`.trim()
                    : null

                const summaryStatus = claim.reviewSummaryStatus || 'NotRequested'
                const decision = claim.reviewDecision || 'Unset'
                const locked = isFinalReviewDecision(claim.reviewDecision)
                const ruleFlagCount = getRuleFlagCount(claim.reviewRuleFlags)
                const needsReviewNow =
                  claim.reviewDecision == null &&
                  claim.status === ClaimStatus.ReadyForAI &&
                  summaryStatus === 'Generated'
                const providerFailed =
                  claim.status === ClaimStatus.ProviderFailed || claim.status === ClaimStatus.ProcessingError

                return (
                  <tr
                    key={claim.id}
                    className={
                      providerFailed
                        ? 'border-b bg-red-50/40 last:border-0'
                        : needsReviewNow
                          ? 'border-b bg-amber-50/50 last:border-0'
                          : 'border-b last:border-0'
                    }
                  >
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        name="claimIds"
                        value={claim.id}
                        form="bulk-review-form"
                        disabled={locked}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Select ${claim.claimNumber}`}
                      />
                    </td>
                    <td className="py-2 pr-4 font-medium text-slate-900">
                      <Link href={`/admin/claims/${claim.id}`} className="underline underline-offset-2">
                        {claim.claimNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-700">
                      {formatDate(claim.submittedAt)}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={getDecisionBadgeClassName(decision)}>{decision}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={getSummaryBadgeClassName(summaryStatus)}>{summaryStatus}</span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{String(ruleFlagCount)}</td>
                    <td className="py-2 pr-4 text-slate-700" title={providerVehicleHint || undefined}>
                      {truncate(claim.vinDataProvider || providerVehicleHint || claim.vinDataProviderResultMessage)}
                    </td>
                    <td className="py-2 pr-4">{claim.claimantName || '—'}</td>
                    <td className="py-2 pr-4">{claim.vin || '—'}</td>
                    <td className="py-2 pr-4">
                      {locked ? (
                        <span className="inline-flex items-center rounded-md border border-slate-400 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          Locked
                        </span>
                      ) : needsReviewNow ? (
                        <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                          Needs Action
                        </span>
                      ) : providerFailed ? (
                        <span className="inline-flex items-center rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                          Provider Issue
                        </span>
                      ) : summaryStatus === 'Queued' ? (
                        <span className="inline-flex items-center rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                          Summarizing
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
