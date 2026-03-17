const baseUrl = process.env.INTAKE_BASE_URL || 'http://localhost:3000'
const url = `${baseUrl}/api/intake/cognito`

const payload = {
  Form: 'Choice Claims Intake',
  CustomerName: {
    First: 'Jordan',
    Last: 'Driver',
    FirstAndLast: 'Jordan Driver'
  },
  FullVIN: '1HGCM82633A004352',
  CustomerEmail: 'not-a-valid-email-format',
  CustomerPhone: '(555) 010-8844',
  Entry: {
    DateSubmitted: new Date().toISOString(),
    Number: '999'
  }
}

const headers = {
  'Content-Type': 'application/json'
}

if (process.env.COGNITO_WEBHOOK_SECRET) {
  headers['x-webhook-secret'] = process.env.COGNITO_WEBHOOK_SECRET
}

async function main() {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  const text = await response.text()

  console.log(`POST ${url}`)
  console.log(`Status: ${response.status}`)
  console.log(text)

  if (response.status !== 400) {
    console.error('Expected HTTP 400 for invalid fixture payload')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Failed to post invalid fixture payload:', error)
  process.exit(1)
})
