import { prisma } from '../../../lib/prisma'

export const dynamic = 'force-dynamic'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

export default async function AdminClaimsPage() {
  const claims = await prisma.claim.findMany({
    orderBy: { submittedAt: 'desc' },
    take: 25,
    select: {
      id: true,
      claimNumber: true,
      status: true,
      claimantName: true,
      vin: true,
      submittedAt: true
    }
  })

  console.info('[ADMIN_CLAIMS] loaded claims from prisma', {
    count: claims.length,
    claimNumbers: claims.slice(0, 5).map((claim) => claim.claimNumber)
  })

  return (
    <section className="card">
      <h1 className="text-2xl">Admin — Claims</h1>
      <p className="mt-3 text-slate-700">Latest submitted claims (most recent first).</p>

      {claims.length === 0 ? (
        <p className="mt-4 text-slate-600">No claims submitted yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 pr-4 font-medium">Claim #</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Claimant</th>
                <th className="py-2 pr-4 font-medium">VIN</th>
                <th className="py-2 pr-4 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium text-slate-900">{claim.claimNumber}</td>
                  <td className="py-2 pr-4">{claim.status}</td>
                  <td className="py-2 pr-4">{claim.claimantName || '—'}</td>
                  <td className="py-2 pr-4">{claim.vin || '—'}</td>
                  <td className="py-2 pr-4">{formatDate(claim.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
