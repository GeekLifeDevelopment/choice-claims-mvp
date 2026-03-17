const baseUrl = process.env.INTAKE_BASE_URL || 'http://localhost:3000'
const url = `${baseUrl}/api/intake/cognito`

const payload = {
  submissionId: 'local-fixture-001',
  submittedAt: new Date().toISOString(),
  repairFacility: {
    name: 'Westside Auto Repair',
    phone: '(555) 010-1200',
    address: '1234 Service Rd, Portland, OR 97201'
  },
  customer: {
    customerName: 'Jordan Driver',
    customerEmail: 'jordan.driver@example.com',
    customerPhone: '(555) 010-8844'
  },
  vehicle: {
    vin: '1HGCM82633A004352',
    milesOnVehicle: '112430'
  },
  complaint: {
    customerComplaint:
      'Vehicle stalls intermittently while idling and has increased vibration under acceleration.'
  },
  uploads: {
    repairOrder: {
      filename: 'repair-order.pdf',
      mimeType: 'application/pdf',
      fileSize: 124221,
      sourceUrl: 'https://example.com/uploads/repair-order.pdf',
      externalId: 'file_ro_001'
    },
    odometer: {
      filename: 'odometer.jpg',
      mimeType: 'image/jpeg',
      sourceUrl: 'https://example.com/uploads/odometer.jpg'
    }
  },
  acknowledgements: {
    termsAccepted: true,
    privacyAccepted: true
  },
  signature: {
    signedName: 'Jordan Driver'
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

  if (!response.ok) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Failed to post fixture payload:', error)
  process.exit(1)
})
