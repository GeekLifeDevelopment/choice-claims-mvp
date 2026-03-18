import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const claimNumber = process.argv[2]

if (!claimNumber) {
  console.error('Usage: node scripts/inspect-claim-audits.mjs <claimNumber>')
  process.exit(1)
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function main() {
  const claim = await prisma.claim.findUnique({
    where: { claimNumber },
    select: {
      id: true,
      claimNumber: true,
      createdAt: true,
      dedupeKey: true,
      source: true,
      rawSubmissionPayload: true,
    },
  })

  if (!claim) {
    console.log(JSON.stringify({ message: 'claim not found', claimNumber }, null, 2))
    return
  }

  const payload = asRecord(claim.rawSubmissionPayload)
  const entry = asRecord(payload.Entry)
  const form = asRecord(payload.Form)

  const auditLogs = await prisma.auditLog.findMany({
    where: { claimId: claim.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      action: true,
      metadata: true,
    },
  })

  console.log(
    JSON.stringify(
      {
        claim: {
          id: claim.id,
          claimNumber: claim.claimNumber,
          createdAt: claim.createdAt,
          source: claim.source,
          dedupeKey: claim.dedupeKey,
        },
        payloadIdentity: {
          id: payload.Id,
          formId: form.Id,
          entryNumber: entry.Number,
          entryDateSubmitted: entry.DateSubmitted,
        },
        auditLogs,
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
