import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function main() {
  const claims = await prisma.claim.findMany({
    where: { source: 'cognito' },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      id: true,
      claimNumber: true,
      createdAt: true,
      submittedAt: true,
      dedupeKey: true,
      vin: true,
      claimantEmail: true,
      rawSubmissionPayload: true,
    },
  })

  const rows = claims.map((claim) => {
    const payload = asRecord(claim.rawSubmissionPayload)
    const entry = asRecord(payload.Entry)
    return {
      claimNumber: claim.claimNumber,
      createdAt: claim.createdAt,
      submittedAt: claim.submittedAt,
      vin: claim.vin,
      claimantEmail: claim.claimantEmail,
      dedupeKey: claim.dedupeKey,
      payloadId: payload.Id,
      entryNumber: entry.Number,
      entryDateSubmitted: entry.DateSubmitted,
    }
  })

  console.log(JSON.stringify(rows, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
