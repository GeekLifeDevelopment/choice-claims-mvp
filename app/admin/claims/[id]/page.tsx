import Link from 'next/link'
import { notFound } from 'next/navigation'
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

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function AdminClaimDetailPage({ params }: PageProps) {
  const { id } = await params

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      claimantName: true,
      vin: true,
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

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl">Claim {claim.claimNumber}</h1>
        <Link href="/admin/claims" className="text-sm text-slate-600 underline underline-offset-2">
          Back to Claims
        </Link>
      </div>

      <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
        <p>
          <span className="font-medium text-slate-900">Status:</span> {claim.status}
        </p>
        <p>
          <span className="font-medium text-slate-900">Source:</span> {claim.source || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant:</span> {claim.claimantName || '—'}
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
