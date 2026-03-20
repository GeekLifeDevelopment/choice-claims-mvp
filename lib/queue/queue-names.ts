export const QUEUE_NAMES = {
  VIN_DATA: 'vin-data',
  REVIEW_SUMMARY: 'review-summary'
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]
