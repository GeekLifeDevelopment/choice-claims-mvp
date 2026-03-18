import { Queue, type QueueOptions } from 'bullmq'
import { getQueueRuntimeConfig } from './config'
import type { QueueName } from './queue-names'

export function getQueue(
  queueName: QueueName,
  options: Omit<QueueOptions, 'connection' | 'prefix'> = {}
): Queue {
  if (!queueName.trim()) {
    throw new Error('[QUEUE_CONFIG] Queue name is required when creating a BullMQ queue')
  }

  const { connection, prefix } = getQueueRuntimeConfig()

  return new Queue(queueName, {
    ...options,
    connection,
    prefix
  })
}
