import Link from 'next/link'
import { Prisma } from '@prisma/client'
import { ClaimStatus } from '../../../lib/domain/claims'
import { prisma } from '../../../lib/prisma'

export const dynamic = 'force-dynamic'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

const ASYNC_STATUSES: ReadonlyArray<ClaimStatus> = [
  ClaimStatus.AwaitingVinData,
  ClaimStatus.ReadyForAI,
  ClaimStatus.ProviderFailed,
  ClaimStatus.ProcessingError
]

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
  searchParams: Promise<{ status?: string }>
}

const CLAIM_ROW_SELECT = {
  id: true,
  claimNumber: true,
  status: true,
  reviewDecision: true,
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
  attachments: {
    select: {
      id: true,
      sourceUrl: true
    }
  }
} satisfies Prisma.ClaimSelect

type ClaimRow = Prisma.ClaimGetPayload<{ select: typeof CLAIM_ROW_SELECT }>

export default async function AdminClaimsPage({ searchParams }: PageProps) {
  const resolvedSearchParams = await searchParams
  const requestedStatus = resolvedSearchParams.status
  const selectedStatus =
    requestedStatus && ASYNC_STATUSES.includes(requestedStatus as ClaimStatus)
      ? (requestedStatus as ClaimStatus)
      : 'all'

  let dbError: string | null = null
  let claims: ClaimRow[] = []

  try {
    claims = await prisma.claim.findMany({
      where: selectedStatus === 'all' ? undefined : { status: selectedStatus },
      orderBy: { submittedAt: 'desc' },
      take: 25,
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
      message
    })
  }

  return (
    <section className="card">
      <h1 className="text-2xl">Admin — Claims</h1>
      <p className="mt-3 text-slate-700">Latest submitted claims (most recent first).</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-700">Async Status:</span>
        <Link
          href="/admin/claims"
          className={
            selectedStatus === 'all'
              ? 'rounded-md border border-slate-300 bg-slate-100 px-2 py-1 font-medium text-slate-900'
              : 'rounded-md border border-slate-200 px-2 py-1 text-slate-700 hover:bg-slate-50'
          }
        >
          All
        </Link>
        {ASYNC_STATUSES.map((status) => (
          <Link
            key={status}
            href={`/admin/claims?status=${status}`}
            className={
              selectedStatus === status
                ? 'rounded-md border border-slate-300 bg-slate-100 px-2 py-1 font-medium text-slate-900'
                : 'rounded-md border border-slate-200 px-2 py-1 text-slate-700 hover:bg-slate-50'
            }
          >
            {status}
          </Link>
        ))}
      </div>

      {dbError ? (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Unable to load claims right now because the database is not reachable.
          <br />
          <span className="text-red-700">Details: {dbError}</span>
        </div>
      ) : null}

      {!dbError && claims.length === 0 ? (
        <p className="mt-4 text-slate-600">No claims submitted yet.</p>
      ) : !dbError ? (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 pr-4 font-medium">Claim #</th>
                <th className="py-2 pr-4 font-medium">Async Status</th>
                <th className="py-2 pr-4 font-medium">Review Decision</th>
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">Fetched</th>
                <th className="py-2 pr-4 font-medium">Provider Result</th>
                <th className="py-2 pr-4 font-medium">Run Attempts</th>
                <th className="py-2 pr-4 font-medium">Last Error</th>
                <th className="py-2 pr-4 font-medium">Claimant</th>
                <th className="py-2 pr-4 font-medium">VIN</th>
                <th className="py-2 pr-4 font-medium">Attachments</th>
                <th className="py-2 pr-4 font-medium">Has File URL</th>
                <th className="py-2 pr-4 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => {
                const normalizedResult = asRecord(claim.vinDataResult)
                const year = getOptionalNumber(normalizedResult.year)
                const make = getOptionalString(normalizedResult.make)
                const model = getOptionalString(normalizedResult.model)
                const vehicleSummary =
                  year !== null || make || model
                    ? `${year !== null ? `${year} ` : ''}${make ?? ''} ${model ?? ''}`.trim()
                    : null

                const providerResultLabel =
                  vehicleSummary ??
                  claim.vinDataProviderResultMessage ??
                  (claim.vinDataProviderResultCode !== null
                    ? `Code ${claim.vinDataProviderResultCode}`
                    : claim.status === ClaimStatus.ProviderFailed ||
                        claim.status === ClaimStatus.ProcessingError
                      ? 'Failed'
                      : claim.vinDataFetchedAt
                        ? 'Fetched'
                        : 'Pending')

                return (
                  <tr
                    key={claim.id}
                    className={
                      claim.status === ClaimStatus.ProviderFailed ||
                      claim.status === ClaimStatus.ProcessingError
                        ? 'border-b bg-red-50/40 last:border-0'
                        : 'border-b last:border-0'
                    }
                  >
                    <td className="py-2 pr-4 font-medium text-slate-900">
                      <Link href={`/admin/claims/${claim.id}`} className="underline underline-offset-2">
                        {claim.claimNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{claim.reviewDecision || '—'}</td>
                    <td className="py-2 pr-4">{claim.vinDataProvider || '—'}</td>
                    <td className="py-2 pr-4 text-slate-700">
                      {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-slate-700" title={providerResultLabel}>
                      {truncate(providerResultLabel)}
                    </td>
                    <td className="py-2 pr-4">{String(claim.vinLookupAttemptCount ?? 0)}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          claim.vinLookupLastError
                            ? 'font-medium text-red-700'
                            : 'text-slate-500'
                        }
                        title={claim.vinLookupLastError || undefined}
                      >
                        {truncate(claim.vinLookupLastError)}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{claim.claimantName || '—'}</td>
                    <td className="py-2 pr-4">{claim.vin || '—'}</td>
                    <td className="py-2 pr-4">{claim.attachments.length}</td>
                    <td className="py-2 pr-4">
                      {claim.attachments.some((attachment) => Boolean(attachment.sourceUrl)) ? 'Yes' : 'No'}
                    </td>
                    <td className="py-2 pr-4">{formatDate(claim.submittedAt)}</td>
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
