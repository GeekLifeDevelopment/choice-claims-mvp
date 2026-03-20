import Link from 'next/link'
import { Prisma } from '@prisma/client'
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

const SORT_FILTER_VALUES = [
  'submitted_desc',
  'submitted_asc',
  'updated_desc',
  'evaluated_desc',
  'summarized_desc'
] as const
type SortFilterValue = (typeof SORT_FILTER_VALUES)[number]

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
    sort?: string
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
  selectedSort: SortFilterValue,
  patch?: Partial<{
    status: StatusFilterValue
    decision: DecisionFilterValue
    summary: SummaryFilterValue
    sort: SortFilterValue
  }>
): string {
  const nextStatus = patch?.status ?? selectedStatus
  const nextDecision = patch?.decision ?? selectedDecision
  const nextSummary = patch?.summary ?? selectedSummary
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

  if (nextSort !== 'submitted_desc') {
    params.set('sort', nextSort)
  }

  const query = params.toString()
  return query ? `/admin/claims?${query}` : '/admin/claims'
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

  if (sort === 'evaluated_desc') {
    return [{ reviewRuleEvaluatedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  if (sort === 'summarized_desc') {
    return [{ reviewSummaryGeneratedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  return [{ submittedAt: 'desc' }]
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
    (selectedSummary === 'all' ? 0 : 1)

  return (
    <section className="card">
      <h1 className="text-2xl">Admin — Claims</h1>
      <p className="mt-2 text-slate-700">
        Reviewer queue with server-side status, decision, summary, and sort controls.
      </p>

      <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Queue Presets:</span>
          <Link
            href={buildClaimsUrl('all', 'all', 'all', selectedSort)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100"
          >
            All
          </Link>
          <Link
            href={buildClaimsUrl(ClaimStatus.ReadyForAI, 'Unset', 'Generated', selectedSort)}
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 hover:bg-amber-100"
          >
            Needs Review Now
          </Link>
          <Link
            href={buildClaimsUrl(ClaimStatus.AwaitingVinData, 'all', 'all', selectedSort)}
            className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-sky-900 hover:bg-sky-100"
          >
            Waiting on Provider
          </Link>
          <Link
            href={buildClaimsUrl('all', 'Unset', 'Generated', selectedSort)}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900 hover:bg-emerald-100"
          >
            Summary Ready
          </Link>
          <Link
            href={buildClaimsUrl('all', 'Approved', 'all', selectedSort)}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900 hover:bg-emerald-100"
          >
            Approved
          </Link>
          <Link
            href={buildClaimsUrl('all', 'Denied', 'all', selectedSort)}
            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-red-900 hover:bg-red-100"
          >
            Denied
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Status:</span>
          {STATUS_FILTER_VALUES.map((status) => (
            <Link
              key={status}
              href={buildClaimsUrl(selectedStatus, selectedDecision, selectedSummary, selectedSort, {
                status
              })}
              className={
                selectedStatus === status
                  ? 'rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-900'
                  : 'rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100'
              }
            >
              {status === 'all' ? 'All' : status}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Reviewer Decision:</span>
          {DECISION_FILTER_VALUES.map((decision) => (
            <Link
              key={decision}
              href={buildClaimsUrl(selectedStatus, selectedDecision, selectedSummary, selectedSort, {
                decision
              })}
              className={
                selectedDecision === decision
                  ? 'rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-900'
                  : 'rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100'
              }
            >
              {decision}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Summary:</span>
          {SUMMARY_FILTER_VALUES.map((summary) => (
            <Link
              key={summary}
              href={buildClaimsUrl(selectedStatus, selectedDecision, selectedSummary, selectedSort, {
                summary
              })}
              className={
                selectedSummary === summary
                  ? 'rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-900'
                  : 'rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100'
              }
            >
              {summary}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Sort:</span>
          {SORT_FILTER_VALUES.map((sort) => {
            const label =
              sort === 'submitted_desc'
                ? 'Newest submitted'
                : sort === 'submitted_asc'
                  ? 'Oldest submitted'
                  : sort === 'updated_desc'
                    ? 'Recently updated'
                    : sort === 'evaluated_desc'
                      ? 'Recently evaluated'
                      : 'Recently summarized'

            return (
              <Link
                key={sort}
                href={buildClaimsUrl(selectedStatus, selectedDecision, selectedSummary, selectedSort, {
                  sort
                })}
                className={
                  selectedSort === sort
                    ? 'rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-900'
                    : 'rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100'
                }
              >
                {label}
              </Link>
            )
          })}
        </div>

        <p className="text-xs text-slate-600">
          Showing {claims.length} claims{filterCount > 0 ? ` with ${filterCount} active filters` : ''}.
        </p>
      </div>

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
