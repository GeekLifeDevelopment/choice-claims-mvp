import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const dedupeKey = process.argv[2]

if (!dedupeKey) {
  console.error('Usage: node scripts/inspect-dedupe-key.mjs <dedupeKey>')
  process.exit(1)
}

async function main() {
  const claim = await prisma.claim.findUnique({
    where: { dedupeKey },
    select: {
      id: true,
      claimNumber: true,
      dedupeKey: true,
      source: true,
      submittedAt: true,
      vin: true,
      claimantEmail: true,
      rawSubmissionPayload: true,
    },
  })

  if (!claim) {
    console.log('no claim found for dedupe key')
    return
  }

  const payload = claim.rawSubmissionPayload
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const topKeys = Object.keys(record).slice(0, 50)
  const topId = record.Id
  const topEntryId = record.EntryId

  const entry = record.Entry && typeof record.Entry === 'object' && !Array.isArray(record.Entry)
    ? record.Entry
    : {}

  const entryNumber = entry.Number
  const entryDateSubmitted = entry.DateSubmitted
  const entryTimestamp = entry.Timestamp
  const entryDateCreated = entry.DateCreated

  console.log(
    JSON.stringify(
      {
        claim: {
          id: claim.id,
          claimNumber: claim.claimNumber,
          source: claim.source,
          submittedAt: claim.submittedAt,
          vin: claim.vin,
          claimantEmail: claim.claimantEmail,
          dedupeKey: claim.dedupeKey,
        },
        payloadPreview: {
          topKeys,
          topId,
          topEntryId,
          entryNumber,
          entryDateSubmitted,
          entryTimestamp,
          entryDateCreated,
        },
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
