import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const email = 'info@anotherTestREpar.com'
const vin = 'v4568764156344531'
const idCandidates = ['5726', '93-5726']

try {
  const claims = await prisma.$queryRawUnsafe(`
    SELECT
      "id",
      "claimNumber",
      "status",
      "source",
      "claimantEmail",
      "vin",
      "submittedAt",
      "createdAt",
      "rawSubmissionPayload"->>'Id' AS payload_id,
      "rawSubmissionPayload"->'Entry'->>'Number' AS entry_number
    FROM "Claim"
    WHERE
      LOWER(COALESCE("claimantEmail", '')) = LOWER($1)
      OR LOWER(COALESCE("vin", '')) = LOWER($2)
      OR "rawSubmissionPayload"->>'Id' = ANY($3)
      OR "rawSubmissionPayload"->'Entry'->>'Number' = ANY($3)
    ORDER BY "createdAt" DESC
    LIMIT 100;
  `, email, vin, idCandidates)

  const audits = await prisma.$queryRawUnsafe(`
    SELECT
      a."createdAt",
      a."action",
      a."metadata",
      c."id" AS claim_id,
      c."claimNumber",
      c."status"
    FROM "AuditLog" a
    LEFT JOIN "Claim" c ON c."id" = a."claimId"
    WHERE
      a."metadata"::text ILIKE $1
      OR a."metadata"::text ILIKE $2
      OR a."metadata"::text ILIKE $3
      OR a."metadata"::text ILIKE $4
    ORDER BY a."createdAt" DESC
    LIMIT 150;
  `, `%${email}%`, `%${vin}%`, '%5726%', '%93-5726%')

  console.log(
    JSON.stringify(
      {
        search: { email, vin, idCandidates },
        claims,
        audits,
      },
      null,
      2,
    ),
  )
} finally {
  await prisma.$disconnect()
}
