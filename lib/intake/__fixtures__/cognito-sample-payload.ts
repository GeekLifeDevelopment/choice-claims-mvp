export const cognitoSamplePayload = {
  submissionId: 'sample-submission-001',
  submittedAt: '2026-03-17T15:00:00.000Z',
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
    repairEstimate: {
      filename: 'repair-estimate.pdf',
      mimeType: 'application/pdf',
      sourceUrl: 'https://example.com/uploads/repair-estimate.pdf'
    },
    photos: [
      {
        filename: 'under-hood.jpg',
        mimeType: 'image/jpeg',
        fileSize: 89912,
        sourceUrl: 'https://example.com/uploads/under-hood.jpg',
        storageKey: 'cognito/claims/under-hood.jpg'
      },
      {
        filename: 'odometer.jpg',
        mimeType: 'image/jpeg',
        sourceUrl: 'https://example.com/uploads/odometer.jpg'
      }
    ]
  },
  acknowledgements: {
    termsAccepted: true,
    privacyAccepted: true
  },
  signature: {
    signedName: 'Jordan Driver'
  }
} as const
