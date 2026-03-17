export enum ClaimStatus {
  Submitted = 'Submitted'
}

export const NORMALIZED_INTAKE_FIELDS = {
  source: 'source',
  submittedAt: 'submittedAt',
  vin: 'vin',
  claimantName: 'claimantName',
  claimantEmail: 'claimantEmail',
  claimantPhone: 'claimantPhone',
  attachments: 'attachments',
  rawSubmissionPayload: 'rawSubmissionPayload'
} as const

export type IntakeAttachmentMetadata = {
  filename: string
  mimeType?: string
  fileSize?: number
  sourceUrl?: string
  storageKey?: string
  externalId?: string
}

export type NormalizedIntakePayload = {
  source: string
  submittedAt: string
  vin?: string
  claimantName?: string
  claimantEmail?: string
  claimantPhone?: string
  attachments: IntakeAttachmentMetadata[]
  rawSubmissionPayload: unknown
}

export type CreateClaimFromIntakeInput = {
  status: ClaimStatus
  source: string
  submittedAt: Date
  vin?: string
  claimantName?: string
  claimantEmail?: string
  claimantPhone?: string
  attachments: IntakeAttachmentMetadata[]
  rawSubmissionPayload: unknown
}

export function toCreateClaimFromIntakeInput(
  payload: NormalizedIntakePayload
): CreateClaimFromIntakeInput {
  return {
    status: ClaimStatus.Submitted,
    source: payload.source,
    submittedAt: new Date(payload.submittedAt),
    vin: payload.vin,
    claimantName: payload.claimantName,
    claimantEmail: payload.claimantEmail,
    claimantPhone: payload.claimantPhone,
    attachments: payload.attachments,
    rawSubmissionPayload: payload.rawSubmissionPayload
  }
}
