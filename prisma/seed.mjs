import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const claim = await prisma.claim.upsert({
    where: { claimNumber: 'SEED-0001' },
    update: {
      status: 'new',
      source: 'seed-script',
      claimantName: 'Seed User',
      claimantEmail: 'seed@example.com',
      rawSubmissionPayload: { seeded: true, version: 1 },
      submittedAt: new Date()
    },
    create: {
      claimNumber: 'SEED-0001',
      status: 'new',
      source: 'seed-script',
      claimantName: 'Seed User',
      claimantEmail: 'seed@example.com',
      rawSubmissionPayload: { seeded: true, version: 1 },
      submittedAt: new Date()
    }
  })

  await prisma.auditLog.create({
    data: {
      claimId: claim.id,
      action: 'seed.claim.upsert',
      metadata: { claimNumber: claim.claimNumber }
    }
  })

  console.log(`Seed complete for claim ${claim.claimNumber}`)
}

main()
  .catch((error) => {
    console.error('Seed failed:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
