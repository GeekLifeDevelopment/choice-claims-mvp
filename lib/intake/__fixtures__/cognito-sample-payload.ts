export const cognitoSamplePayload = {
  Form: 'Choice Claims Intake',
  NameOfServiceWriter: {
    First: 'Alex',
    Last: 'Writer',
    FirstAndLast: 'Alex Writer'
  },
  RepairFacilityEmailAddress: 'service@westsideautorepair.com',
  RepairFacilityPhone: '(555) 010-1200',
  NameOfRepairFacility: 'Westside Auto Repair',
  CustomerName: {
    First: 'Jordan',
    Last: 'Driver',
    FirstAndLast: 'Jordan Driver'
  },
  FullVIN: '1HGCM82633A004352',
  CustomerPhone: '(555) 010-8844',
  CustomerEmail: 'jordan.driver@example.com',
  MilesOnVehicle: '112430',
  RepairFacilityAddress: {
    AddressLine1: '1234 Service Rd',
    City: 'Portland',
    State: 'OR',
    ZipCode: '97201',
    FullAddress: '1234 Service Rd, Portland, OR 97201'
  },
  BusinessNameifApplicable: 'Westside Auto Repair LLC',
  CopyOfRepairOrder: [
    {
      ContentType: 'application/pdf',
      Id: 'file_ro_001',
      Name: 'repair-order.pdf',
      Size: 124221,
      File: 'https://cdn.cognitoforms.com/file/repair-order.pdf'
    }
  ],
  CopyOfRepairEstimate: [
    {
      ContentType: 'application/pdf',
      Id: 'file_re_001',
      Name: 'repair-estimate.pdf',
      Size: 91422,
      File: 'https://cdn.cognitoforms.com/file/repair-estimate.pdf'
    }
  ],
  PhotosOfFailedParts: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_fp_001',
      Name: 'failed-part-1.jpg',
      Size: 88912,
      File: 'https://cdn.cognitoforms.com/file/failed-part-1.jpg'
    }
  ],
  Signature: {
    Name: 'signature.png',
    ContentType: 'image/png',
    Content: 'base64-signature-content',
    File: 'https://cdn.cognitoforms.com/file/signature.png'
  },
  PleaseTypeSignedNameAbove: {
    First: 'Jordan',
    Last: 'Driver',
    FirstAndLast: 'Jordan Driver'
  },
  RepairFacilityHourlyLaborRate: '165',
  CauseForVisitCustomerComplaint:
    'Vehicle stalls intermittently while idling and has increased vibration under acceleration.',
  ClaimsSubmissionAcknowledgementHaveYouReadAndUnderstandTheStatementBelow: true,
  IUnderstandThatIMustHaveClaimsApprovalPriorToAnyWorkBeingPerformedOnTheVehicle: true,
  DriverSideProfilePictureOfVehicle: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_dp_001',
      Name: 'driver-profile.jpg',
      Size: 104221,
      File: 'https://cdn.cognitoforms.com/file/driver-profile.jpg'
    }
  ],
  PictureUnderTheHood: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_hh_001',
      Name: 'under-hood.jpg',
      Size: 98221,
      File: 'https://cdn.cognitoforms.com/file/under-hood.jpg'
    }
  ],
  UnderCarriagePicture: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_uc_001',
      Name: 'under-carriage.jpg',
      Size: 92321,
      File: 'https://cdn.cognitoforms.com/file/under-carriage.jpg'
    }
  ],
  PictureOfOdometer: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_od_001',
      Name: 'odometer.jpg',
      Size: 74562,
      File: 'https://cdn.cognitoforms.com/file/odometer.jpg'
    }
  ],
  RearProfilePictureOfVehicle: [
    {
      ContentType: 'image/jpeg',
      Id: 'file_rp_001',
      Name: 'rear-profile.jpg',
      Size: 89221,
      File: 'https://cdn.cognitoforms.com/file/rear-profile.jpg'
    }
  ],
  IHaveUploadedIndividualImagesAsRequestedAboveClaimsCannotBeProcessedWithoutClearImagesUploaded: true,
  WhenRepairsAreCompleteIUnderstandThatINeedToGoToChoiceAutoProtectioncomAndSubmitForClaimPaymentLinkHereHttpschoiceautoprotectioncomsubmitforclaimpayment:
    true,
  Id: 'entry_12345',
  Entry: {
    DateCreated: '2026-03-17T14:58:00.000Z',
    DateSubmitted: '2026-03-17T15:00:00.000Z',
    DateUpdated: '2026-03-17T15:01:00.000Z',
    Timestamp: '2026-03-17T15:00:00.000Z',
    Number: '142',
    Status: 'Submitted',
    Action: 'Create',
    AdminLink: 'https://www.cognitoforms.com/admin/entry/142'
  },
  _note: 'Sample fixture aligned to captured Cognito webhook payload shape'
} as const
