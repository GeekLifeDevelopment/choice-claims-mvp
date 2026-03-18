import fs from 'node:fs'

const baseUrl = process.env.INTAKE_URL || 'http://localhost:3000/api/intake/cognito'
const payload = JSON.parse(fs.readFileSync('test/fixtures/cognito/valid-claim.json', 'utf8'))
const secret = process.env.COGNITO_WEBHOOK_SECRET

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

  const modified = structuredClone(payload)
  const uniqueSuffix = Date.now().toString()
  modified.Id = `${payload.Id}-new-submission-${Date.now()}`
  if (modified.Entry && modified.Entry.Number) {
    modified.Entry.Number = `${modified.Entry.Number}-NEW-${uniqueSuffix}`
  }

  const secondUnique = await post(modified)

  console.log('first_status=', first.status, 'first_duplicate=', first.json.duplicate)
  console.log('replay_status=', replay.status, 'replay_duplicate=', replay.json.duplicate)
  console.log('second_unique_status=', secondUnique.status, 'second_unique_duplicate=', secondUnique.json.duplicate)
  console.log('second_unique_claimNumber=', secondUnique.json?.claim?.claimNumber)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
