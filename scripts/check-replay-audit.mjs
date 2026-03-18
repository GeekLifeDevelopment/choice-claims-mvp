import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const baseUrl = process.env.INTAKE_URL || 'http://localhost:3000/api/intake/cognito'
const secret = process.env.COGNITO_WEBHOOK_SECRET

const template = JSON.parse(fs.readFileSync('test/fixtures/cognito/valid-claim.json', 'utf8'))

const uniqueSuffix = Date.now().toString()
const payload = structuredClone(template)
payload.Id = `${template.Id}-audit-replay-${uniqueSuffix}`
if (payload.Entry && payload.Entry.Number) {
  payload.Entry.Number = `${payload.Entry.Number}-AUDIT-${uniqueSuffix}`
}

async function post(body) {
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['x-webhook-secret'] = secret

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const json = await res.json()
  return { status: res.status, json }
}

async function main() {
  const first = await post(payload)
  const replay = await post(payload)

  const claimNumber = first.json?.claim?.claimNumber || replay.json?.claim?.claimNumber
  if (!claimNumber) {
    console.log(JSON.stringify({ first, replay, error: 'missing claimNumber' }, null, 2))
    return
  }

  const claim = await prisma.claim.findUnique({
    where: { claimNumber },
    select: { id: true, claimNumber: true, dedupeKey: true },
  })

  if (!claim) {
    console.log(JSON.stringify({ first, replay, error: 'claim not found' }, null, 2))
    return
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      claimId: claim.id,
      action: {
        in: ['claim_created', 'duplicate_blocked', 'duplicate_replay_ignored'],
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true, metadata: true },
  })

  console.log(
    JSON.stringify(
      {
        first,
        replay,
        claim,
        logs,
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
