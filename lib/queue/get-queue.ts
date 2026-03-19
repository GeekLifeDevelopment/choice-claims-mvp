import { Queue, type QueueOptions } from 'bullmq'
import { getQueueRuntimeConfig } from './config'
import type { QueueName } from './queue-names'
import { resolveVinLookupBackoffStrategyDelay } from './vin-lookup-job-options'

export function getQueue(
  queueName: QueueName,
  options: Omit<QueueOptions, 'connection' | 'prefix'> = {}
): Queue {
  if (!queueName.trim()) {
    throw new Error('[QUEUE_CONFIG] Queue name is required when creating a BullMQ queue')
  }

  const { connection, prefix } = getQueueRuntimeConfig()

  // BullMQ supports custom backoff strategy functions on queue settings at runtime,
  // but the published QueueOptions type narrows settings to repeat options only.
  const queueOptions = {
    ...options,
    settings: {
      ...options.settings,
      backoffStrategy(attemptsMade: number, type?: string, error?: Error) {
        return resolveVinLookupBackoffStrategyDelay(attemptsMade, type, error)
      }
    },
    connection,
    prefix
  } as unknown as QueueOptions

  return new Queue(queueName, queueOptions)
}
