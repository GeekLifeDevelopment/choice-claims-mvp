export const QUEUE_NAMES = {
  VIN_DATA: 'vin-data'
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]
