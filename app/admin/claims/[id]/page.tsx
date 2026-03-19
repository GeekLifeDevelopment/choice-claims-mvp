import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ClaimStatus } from '../../../../lib/domain/claims'
import { prisma } from '../../../../lib/prisma'

export const dynamic = 'force-dynamic'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

function formatFileSize(value?: number | null): string {
  if (!value || value <= 0) {
    return '—'
  }

  return `${Math.round((value / 1024) * 10) / 10} KB`
}

function formatMetadataPreview(value: unknown): string {
  if (value == null) {
    return '—'
  }

  const serialized = JSON.stringify(value)
  if (!serialized) {
    return '—'
  }

  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized
}

function formatDebugJson(value: unknown): string {
  if (value == null) {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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

const ASYNC_AUDIT_ACTIONS = new Set([
  'vin_lookup_enqueued',
  'vin_data_fetched',
  'vin_data_fetch_failed'
])

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

type PageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ retry?: string }>
}

function getRetryBannerMessage(retryParam: string | undefined): string | null {
  if (retryParam === 'queued') {
    return 'VIN retry was queued successfully.'
  }

  if (retryParam === 'not-found') {
    return 'Retry failed: claim was not found.'
  }

  if (retryParam === 'invalid-status') {
    return 'Retry is only available when claim status is ProviderFailed.'
  }

  if (retryParam === 'enqueue-failed') {
    return 'Retry failed: unable to enqueue VIN lookup job.'
  }

  return null
}

function getRetryBannerClassName(retryParam: string | undefined): string {
  if (retryParam === 'queued') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

export default async function AdminClaimDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const retryBannerMessage = getRetryBannerMessage(resolvedSearchParams.retry)

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      claimantName: true,
      claimantEmail: true,
      claimantPhone: true,
      vin: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      vinDataResult: true,
      vinLookupAttemptCount: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinLookupLastJobId: true,
      vinLookupLastJobName: true,
      vinLookupLastQueueName: true,
      rawSubmissionPayload: true,
      submittedAt: true,
      attachments: {
        orderBy: { uploadedAt: 'asc' },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          fileSize: true,
          sourceUrl: true,
          externalId: true,
          storageKey: true,
          uploadedAt: true
        }
      },
      auditLogs: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          action: true,
          metadata: true,
          createdAt: true
        }
      }
    }
  })

  if (!claim) {
    notFound()
  }

  const vinDataResult = asRecord(claim.vinDataResult)
  const vinDataYear = getOptionalNumber(vinDataResult.year)
  const vinDataMake = getOptionalString(vinDataResult.make)
  const vinDataModel = getOptionalString(vinDataResult.model)
  const asyncAuditLogs = claim.auditLogs.filter((auditLog) => ASYNC_AUDIT_ACTIONS.has(auditLog.action))

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl">Claim {claim.claimNumber}</h1>
        <Link href="/admin/claims" className="text-sm text-slate-600 underline underline-offset-2">
          Back to Claims
        </Link>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Claim Info</h2>
      </div>

      {retryBannerMessage ? (
        <p className={getRetryBannerClassName(resolvedSearchParams.retry)}>{retryBannerMessage}</p>
      ) : null}

      <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
        <p>
          <span className="font-medium text-slate-900">Claim #:</span> {claim.claimNumber}
        </p>
        <p>
          <span className="font-medium text-slate-900">Status:</span>{' '}
          <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
        </p>
        <p>
          <span className="font-medium text-slate-900">Source:</span> {claim.source || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant:</span> {claim.claimantName || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant Email:</span>{' '}
          {claim.claimantEmail || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant Phone:</span>{' '}
          {claim.claimantPhone || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">VIN:</span> {claim.vin || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Submitted:</span> {formatDate(claim.submittedAt)}
        </p>
        <p>
          <span className="font-medium text-slate-900">Attachment Count:</span> {claim.attachments.length}
        </p>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Raw Submission Data</h2>
        {!claim.rawSubmissionPayload ? (
          <p className="text-slate-600">Raw submission payload is not available for this claim.</p>
        ) : (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-600">
              Developer JSON Debug
            </p>
            <pre className="max-h-[28rem] overflow-auto text-xs leading-5 text-slate-800">
              {formatDebugJson(claim.rawSubmissionPayload)}
            </pre>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Async VIN Processing</h2>
        {claim.status === ClaimStatus.ProviderFailed ? (
          <form method="post" action={`/api/admin/claims/${claim.id}/retry-vin`}>
            <button
              type="submit"
              className="inline-flex items-center rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Retry VIN Lookup
            </button>
          </form>
        ) : null}
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Async Status:</span>{' '}
            <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Provider:</span> {claim.vinDataProvider || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Fetched At:</span>{' '}
            {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Result Summary:</span>{' '}
            {vinDataYear !== null || vinDataMake || vinDataModel
              ? `${vinDataYear !== null ? `${vinDataYear} ` : ''}${vinDataMake ?? ''} ${vinDataModel ?? ''}`.trim()
              : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Year:</span>{' '}
            {vinDataYear !== null ? String(vinDataYear) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Make / Model:</span>{' '}
            {vinDataMake || vinDataModel ? `${vinDataMake ?? '—'} / ${vinDataModel ?? '—'}` : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Attempt Count:</span>{' '}
            {String(claim.vinLookupAttemptCount)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Failed At:</span>{' '}
            {claim.vinLookupLastFailedAt ? formatDate(claim.vinLookupLastFailedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Error:</span>{' '}
            <span className={claim.vinLookupLastError ? 'font-medium text-red-700' : ''}>
              {claim.vinLookupLastError || '—'}
            </span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Queue:</span>{' '}
            {claim.vinLookupLastQueueName || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Job Name:</span>{' '}
            {claim.vinLookupLastJobName || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Job ID:</span>{' '}
            {claim.vinLookupLastJobId || '—'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Latest Async Audit Events</h2>
        {asyncAuditLogs.length === 0 ? (
          <p className="text-slate-600">No async-specific audit events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Attempts</th>
                  <th className="py-2 pr-4 font-medium">Provider</th>
                  <th className="py-2 pr-4 font-medium">Error / Reason</th>
                </tr>
              </thead>
              <tbody>
                {asyncAuditLogs.map((auditLog) => {
                  const metadata = asRecord(auditLog.metadata)
                  const attemptsMade = getOptionalNumber(metadata.attemptsMade)
                  const attemptsAllowed = getOptionalNumber(metadata.attemptsAllowed)
                  const provider = getOptionalString(metadata.provider)
                  const errorMessage = getOptionalString(metadata.errorMessage)
                  const reason = getOptionalString(metadata.reason)

                  return (
                    <tr key={auditLog.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 whitespace-nowrap">{formatDate(auditLog.createdAt)}</td>
                      <td className="py-2 pr-4 text-slate-900">{auditLog.action}</td>
                      <td className="py-2 pr-4 text-slate-700">
                        {attemptsMade !== null && attemptsAllowed !== null
                          ? `${attemptsMade}/${attemptsAllowed}`
                          : '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{provider || '—'}</td>
                      <td className="py-2 pr-4 text-slate-700">
                        {errorMessage ? (
                          <span className="font-medium text-red-700">{errorMessage}</span>
                        ) : (
                          reason || '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {claim.attachments.length === 0 ? (
        <p className="text-slate-600">No attachments linked to this claim.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 pr-4 font-medium">Filename</th>
                <th className="py-2 pr-4 font-medium">MIME Type</th>
                <th className="py-2 pr-4 font-medium">Size</th>
                <th className="py-2 pr-4 font-medium">Has File URL</th>
                <th className="py-2 pr-4 font-medium">External ID</th>
                <th className="py-2 pr-4 font-medium">Storage Key</th>
              </tr>
            </thead>
            <tbody>
              {claim.attachments.map((attachment) => (
                <tr key={attachment.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 text-slate-900">{attachment.filename}</td>
                  <td className="py-2 pr-4">{attachment.mimeType || '—'}</td>
                  <td className="py-2 pr-4">{formatFileSize(attachment.fileSize)}</td>
                  <td className="py-2 pr-4">{attachment.sourceUrl ? 'Yes' : 'No'}</td>
                  <td className="py-2 pr-4">{attachment.externalId || '—'}</td>
                  <td className="py-2 pr-4">{attachment.storageKey || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Audit Logs</h2>
        {claim.auditLogs.length === 0 ? (
          <p className="text-slate-600">No audit logs linked to this claim yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {claim.auditLogs.map((auditLog) => (
                  <tr key={auditLog.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDate(auditLog.createdAt)}</td>
                    <td className="py-2 pr-4 text-slate-900">{auditLog.action}</td>
                    <td className="py-2 pr-4 text-slate-700">{formatMetadataPreview(auditLog.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
