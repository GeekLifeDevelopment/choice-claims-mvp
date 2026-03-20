import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ClaimStatus } from '../../../../lib/domain/claims'
import { prisma } from '../../../../lib/prisma'
import { isClaimLockedForProcessing } from '../../../../lib/review/claim-lock'

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

function formatReviewDecisionChangeMetadata(value: unknown): {
  fromDecision: string
  toDecision: string
  reviewer: string
  notes: string
} | null {
  const metadata = asRecord(value)
  const toDecision = getOptionalString(metadata.toDecision)

  if (!toDecision) {
    return null
  }

  return {
    fromDecision: getOptionalString(metadata.fromDecision) || 'Unset',
    toDecision,
    reviewer: getOptionalString(metadata.reviewer) || '—',
    notes: getOptionalString(metadata.notes) || '—'
  }
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

type PersistedRuleFlag = {
  code: string
  severity: string
  message: string
}

function getPersistedRuleFlags(value: unknown): PersistedRuleFlag[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null
      }

      const record = asRecord(item)
      const code = getOptionalString(record.code)
      const severity = getOptionalString(record.severity)
      const message = getOptionalString(record.message)

      if (!code || !severity || !message) {
        return null
      }

      return { code, severity, message }
    })
    .filter((flag): flag is PersistedRuleFlag => Boolean(flag))
}

function getProviderSourceHint(normalized: Record<string, unknown>, raw: unknown): string | null {
  const rawRecord = asRecord(raw)
  const rawSource = getOptionalString(rawRecord.source)
  if (rawSource) {
    return rawSource
  }

  const hasVinSpecificationsEnvelope = rawRecord.vinSpecifications !== undefined
  if (hasVinSpecificationsEnvelope) {
    return 'vinSpecifications'
  }

  const normalizedSource = getOptionalString(normalized.source)
  if (normalizedSource) {
    return normalizedSource
  }

  return null
}

function getProviderEndpointHint(raw: unknown): string | null {
  const rawRecord = asRecord(raw)
  if (rawRecord.vinspecifications !== undefined) {
    return 'vinspecifications'
  }

  const hasVinSpecificationsEnvelope = rawRecord.vinSpecifications !== undefined
  return hasVinSpecificationsEnvelope ? 'vinspecifications' : null
}

function getEndpointAttempts(raw: unknown): string[] {
  const rawRecord = asRecord(raw)
  return Object.keys(rawRecord).filter((key) => key !== 'endpointErrors')
}

function getEndpointErrors(raw: unknown): Array<{ endpoint: string; message: string; status?: number; reason?: string }> {
  const rawRecord = asRecord(raw)
  const endpointErrors = asRecord(rawRecord.endpointErrors)

  return Object.entries(endpointErrors)
    .map(([endpoint, details]) => {
      const detailRecord = asRecord(details)
      const message = getOptionalString(detailRecord.message)

      return {
        endpoint,
        message: message || 'Endpoint failed',
        status: getOptionalNumber(detailRecord.status) ?? undefined,
        reason: getOptionalString(detailRecord.reason) ?? undefined
      }
    })
    .filter((entry) => Boolean(entry.endpoint))
}

const ASYNC_AUDIT_ACTIONS = new Set([
  'vin_lookup_enqueued',
  'vin_lookup_requeued',
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
  searchParams: Promise<{ retry?: string; reviewDecision?: string }>
}

function getRetryBannerMessage(retryParam: string | undefined): string | null {
  if (retryParam === 'queued') {
    return 'VIN retry was queued successfully.'
  }

  if (retryParam === 'not-found') {
    return 'Retry failed: claim was not found.'
  }

  if (retryParam === 'invalid-status') {
    return 'Retry is only available when claim status is ProviderFailed or ProcessingError.'
  }

  if (retryParam === 'duplicate-blocked') {
    return 'Retry ignored: claim status changed and is no longer retryable.'
  }

  if (retryParam === 'enqueue-failed') {
    return 'Retry failed: unable to enqueue VIN lookup job.'
  }

  if (retryParam === 'locked_final_decision') {
    return 'Retry blocked: this claim is locked by a final reviewer decision.'
  }

  return null
}

function getRetryBannerClassName(retryParam: string | undefined): string {
  if (retryParam === 'locked_final_decision') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  if (retryParam === 'queued') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getReviewDecisionBannerMessage(value: string | undefined): string | null {
  if (value === 'saved') {
    return 'Reviewer decision was saved successfully.'
  }

  if (value === 'invalid') {
    return 'Save failed: review decision is invalid.'
  }

  if (value === 'not-found') {
    return 'Save failed: claim was not found.'
  }

  if (value === 'error') {
    return 'Save failed: unable to update reviewer decision.'
  }

  return null
}

function getReviewDecisionBannerClassName(value: string | undefined): string {
  if (value === 'saved') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

export default async function AdminClaimDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const retryBannerMessage = getRetryBannerMessage(resolvedSearchParams.retry)
  const reviewDecisionBannerMessage = getReviewDecisionBannerMessage(resolvedSearchParams.reviewDecision)

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
      vinDataRawPayload: true,
      vinDataProviderResultCode: true,
      vinDataProviderResultMessage: true,
      vinLookupRetryRequestedAt: true,
      vinLookupAttemptCount: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      vinLookupLastJobId: true,
      vinLookupLastJobName: true,
      vinLookupLastQueueName: true,
      reviewRuleFlags: true,
      reviewRuleEvaluatedAt: true,
      reviewRuleVersion: true,
      reviewRuleLastError: true,
      reviewSummaryStatus: true,
      reviewSummaryEnqueuedAt: true,
      reviewSummaryGeneratedAt: true,
      reviewSummaryText: true,
      reviewSummaryLastError: true,
      reviewSummaryJobId: true,
      reviewSummaryVersion: true,
      reviewDecision: true,
      reviewDecisionSetAt: true,
      reviewDecisionNotes: true,
      reviewDecisionBy: true,
      reviewDecisionVersion: true,
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
  const legacyEmbeddedRawPayload = vinDataResult.raw
  const resolvedRawProviderPayload = claim.vinDataRawPayload ?? legacyEmbeddedRawPayload ?? null
  const usingLegacyEmbeddedRawPayload = !claim.vinDataRawPayload && legacyEmbeddedRawPayload !== undefined
  const vinDataYear = getOptionalNumber(vinDataResult.year)
  const vinDataMake = getOptionalString(vinDataResult.make)
  const vinDataModel = getOptionalString(vinDataResult.model)
  const providerSourceHint = getProviderSourceHint(vinDataResult, resolvedRawProviderPayload)
  const providerEndpointHint = getProviderEndpointHint(resolvedRawProviderPayload)
  const endpointAttempts = getEndpointAttempts(resolvedRawProviderPayload)
  const endpointErrors = getEndpointErrors(resolvedRawProviderPayload)
  const asyncAuditLogs = claim.auditLogs.filter((auditLog) => ASYNC_AUDIT_ACTIONS.has(auditLog.action))
  const persistedRuleFlags = getPersistedRuleFlags(claim.reviewRuleFlags)
  const claimLockedForProcessing = isClaimLockedForProcessing(claim)

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

      {reviewDecisionBannerMessage ? (
        <p className={getReviewDecisionBannerClassName(resolvedSearchParams.reviewDecision)}>
          {reviewDecisionBannerMessage}
        </p>
      ) : null}

      {claimLockedForProcessing ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Claim is locked for processing because reviewer decision is final ({claim.reviewDecision}).
          Retry/regenerate processing is blocked until override mode is added.
        </p>
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
        <h2 className="text-lg font-semibold text-slate-900">Review Summary</h2>
        {claim.reviewSummaryText ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <pre className="whitespace-pre-wrap text-sm leading-6 text-slate-800">
              {claim.reviewSummaryText}
            </pre>
          </div>
        ) : (
          <p className="text-slate-600">No review summary yet.</p>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Rule Flags</h2>

        {persistedRuleFlags.length === 0 ? (
          <p className="text-slate-600">No rule flags</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Severity</th>
                  <th className="py-2 pr-4 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {persistedRuleFlags.map((flag) => (
                  <tr key={`${flag.code}-${flag.message}`} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 font-medium text-slate-900">{flag.code}</td>
                    <td className="py-2 pr-4 text-slate-700">{flag.severity}</td>
                    <td className="py-2 pr-4 text-slate-700">{flag.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Reviewer Decision</h2>

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Current Decision:</span>{' '}
            {claim.reviewDecision || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Updated:</span>{' '}
            {claim.reviewDecisionSetAt ? formatDate(claim.reviewDecisionSetAt) : '—'}
          </p>
          <p className="sm:col-span-2">
            <span className="font-medium text-slate-900">Current Notes:</span>{' '}
            {claim.reviewDecisionNotes || '—'}
          </p>
        </div>

        <form
          method="post"
          action={`/api/admin/claims/${claim.id}/review-decision`}
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Decision</span>
              <select
                name="decision"
                defaultValue={claim.reviewDecision || 'NeedsReview'}
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              >
                <option value="NeedsReview">NeedsReview</option>
                <option value="Approved">Approved</option>
                <option value="Denied">Denied</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Notes</span>
            <textarea
              name="notes"
              defaultValue={claim.reviewDecisionNotes || ''}
              rows={4}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              placeholder="Add reviewer notes"
            />
          </label>

          <button
            type="submit"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          >
            Save Reviewer Decision
          </button>
        </form>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Provider Summary</h2>
        {claim.status === ClaimStatus.ProviderFailed || claim.status === ClaimStatus.ProcessingError ? (
          <form method="post" action={`/api/admin/claims/${claim.id}/retry-vin`}>
            <button
              type="submit"
              disabled={claimLockedForProcessing}
              className="inline-flex items-center rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              {claimLockedForProcessing ? 'Retry VIN Lookup (Locked)' : 'Retry VIN Lookup'}
            </button>
          </form>
        ) : null}

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Provider:</span> {claim.vinDataProvider || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Year:</span>{' '}
            {vinDataYear !== null ? String(vinDataYear) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Make:</span> {vinDataMake || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Model:</span> {vinDataModel || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Provider Endpoint:</span>{' '}
            {providerEndpointHint || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Fetched At:</span>{' '}
            {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Attachments</h2>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Attachment Count:</span> {claim.attachments.length}
          </p>
          <p>
            <span className="font-medium text-slate-900">Has Attachments:</span>{' '}
            {claim.attachments.length > 0 ? 'Yes' : 'No'}
          </p>
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
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Pipeline Status</h2>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Status:</span>{' '}
            <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Status:</span>{' '}
            {claim.reviewSummaryStatus || 'NotRequested'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Generated At:</span>{' '}
            {claim.reviewSummaryGeneratedAt ? formatDate(claim.reviewSummaryGeneratedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Job ID:</span>{' '}
            {claim.reviewSummaryJobId || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Rule Evaluated At:</span>{' '}
            {claim.reviewRuleEvaluatedAt ? formatDate(claim.reviewRuleEvaluatedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Fetched At:</span>{' '}
            {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Retry Requested At:</span>{' '}
            {claim.vinLookupRetryRequestedAt ? formatDate(claim.vinLookupRetryRequestedAt) : '—'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Debug Data</h2>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Raw Submission Data</summary>
          <div className="mt-3">
            {!claim.rawSubmissionPayload ? (
              <p className="text-slate-600">Raw submission payload is not available for this claim.</p>
            ) : (
              <pre className="max-h-[28rem] overflow-auto text-xs leading-5 text-slate-800">
                {formatDebugJson(claim.rawSubmissionPayload)}
              </pre>
            )}
          </div>
        </details>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Provider JSON</summary>
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-600">
                Normalized Provider Result JSON
              </p>
              {claim.vinDataResult ? (
                <pre className="max-h-[20rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(claim.vinDataResult)}
                </pre>
              ) : (
                <p className="text-slate-600">No normalized provider data persisted yet.</p>
              )}
            </div>

            {endpointErrors.length > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-amber-800">
                  Optional Endpoint Failures
                </p>
                <ul className="space-y-1 text-xs text-amber-900">
                  {endpointErrors.map((entry) => (
                    <li key={entry.endpoint}>
                      <span className="font-medium">{entry.endpoint}:</span> {entry.message}
                      {entry.status !== undefined ? ` (status ${entry.status})` : ''}
                      {entry.reason ? ` [${entry.reason}]` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              {usingLegacyEmbeddedRawPayload ? (
                <p className="mb-2 text-xs text-amber-700">
                  Showing legacy embedded raw payload from normalized result.
                </p>
              ) : null}
              {resolvedRawProviderPayload ? (
                <pre className="max-h-[20rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(resolvedRawProviderPayload)}
                </pre>
              ) : (
                <p className="text-slate-600">No raw provider payload persisted yet.</p>
              )}
            </div>
          </div>
        </details>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Developer Debug</summary>
          <div className="mt-3 space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium text-slate-900">Latest Async Audit Events</p>
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

            <div>
              <p className="mb-2 text-sm font-medium text-slate-900">Audit Logs</p>
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
                          <td className="py-2 pr-4 text-slate-700">
                            {auditLog.action === 'review_decision_changed' ? (
                              (() => {
                                const change = formatReviewDecisionChangeMetadata(auditLog.metadata)
                                if (!change) {
                                  return formatMetadataPreview(auditLog.metadata)
                                }

                                return (
                                  <div className="space-y-1">
                                    <p>
                                      Decision changed: <span className="font-medium">{change.fromDecision}</span>{' '}
                                      -&gt; <span className="font-medium">{change.toDecision}</span>
                                    </p>
                                    <p>Reviewer: {change.reviewer}</p>
                                    <p>Notes: {change.notes}</p>
                                  </div>
                                )
                              })()
                            ) : (
                              formatMetadataPreview(auditLog.metadata)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {claim.reviewRuleFlags ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Rule Flags JSON</p>
                <pre className="max-h-[16rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(claim.reviewRuleFlags)}
                </pre>
              </div>
            ) : null}

            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Summary Version:</span>{' '}
                {claim.reviewSummaryVersion || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Rule Version:</span>{' '}
                {claim.reviewRuleVersion || '—'}
              </p>
              <p className="sm:col-span-2">
                <span className="font-medium text-slate-900">Rule Last Error:</span>{' '}
                <span className={claim.reviewRuleLastError ? 'font-medium text-red-700' : ''}>
                  {claim.reviewRuleLastError || '—'}
                </span>
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Source Hint:</span>{' '}
                {providerSourceHint || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Endpoints Attempted:</span>{' '}
                {endpointAttempts.length > 0 ? endpointAttempts.join(', ') : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Result Code:</span>{' '}
                {claim.vinDataProviderResultCode !== null ? String(claim.vinDataProviderResultCode) : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Result Message:</span>{' '}
                {claim.vinDataProviderResultMessage || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Run Attempt Count:</span>{' '}
                {String(claim.vinLookupAttemptCount)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Last Failed At:</span>{' '}
                {claim.vinLookupLastFailedAt ? formatDate(claim.vinLookupLastFailedAt) : '—'}
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
              <p>
                <span className="font-medium text-slate-900">Summary Enqueued At:</span>{' '}
                {claim.reviewSummaryEnqueuedAt ? formatDate(claim.reviewSummaryEnqueuedAt) : '—'}
              </p>
            </div>
          </div>
        </details>
      </div>
    </section>
  )
}
