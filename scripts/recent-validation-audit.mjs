import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: 'intake_validation_failed'
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      createdAt: true,
      metadata: true
    }
  })

  const out = rows.map((r) => ({
    createdAt: r.createdAt.toISOString(),
    requestId: r.metadata?.requestId,
    source: r.metadata?.source,
    topLevelKeys: r.metadata?.topLevelKeys,
    issues: r.metadata?.issues
  }))

  console.log(JSON.stringify(out, null, 2))
} finally {
  await prisma.$disconnect()
}
