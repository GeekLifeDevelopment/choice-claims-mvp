import { z } from 'zod'
import type { IntakeAttachmentMetadata, NormalizedIntakePayload } from '../domain/claims'

export const intakeAttachmentMetadataSchema = z.object({
  filename: z.string().min(1, 'filename is required'),
  mimeType: z.string().min(1).optional(),
  fileSize: z.number().int().nonnegative().optional(),
  sourceUrl: z.string().url().optional(),
  storageKey: z.string().min(1).optional(),
  externalId: z.string().min(1).optional()
})

export const normalizedIntakePayloadSchema = z.object({
  source: z.string().min(1, 'source is required'),
  submittedAt: z
    .string()
    .min(1, 'submittedAt is required')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'submittedAt must be a valid datetime string'),
  vin: z.string().min(1).optional(),
  claimantName: z.string().min(1).optional(),
  claimantEmail: z.string().email().optional(),
  claimantPhone: z.string().min(1).optional(),
  attachments: z.array(intakeAttachmentMetadataSchema).default([]),
  rawSubmissionPayload: z.unknown()
})

export type IntakeAttachmentMetadataInput = z.infer<typeof intakeAttachmentMetadataSchema>
export type NormalizedIntakePayloadInput = z.infer<typeof normalizedIntakePayloadSchema>

const _attachmentTypeCheck: IntakeAttachmentMetadata = {} as IntakeAttachmentMetadataInput
void _attachmentTypeCheck

export function parseNormalizedIntakePayload(input: unknown): NormalizedIntakePayload {
  const parsed = normalizedIntakePayloadSchema.parse(input)

  return {
    ...parsed,
    rawSubmissionPayload: parsed.rawSubmissionPayload
  }
}
