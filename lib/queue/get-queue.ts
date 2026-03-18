import { Queue, type QueueOptions } from 'bullmq'
import { getQueueRuntimeConfig } from './config'

export function getQueue(
  queueName: string,
  options: Omit<QueueOptions, 'connection' | 'prefix'> = {}
): Queue {
  const trimmedQueueName = queueName.trim()

  if (!trimmedQueueName) {
    throw new Error('[QUEUE_CONFIG] Queue name is required when creating a BullMQ queue')
  }

  const { connection, prefix } = getQueueRuntimeConfig()

  return new Queue(trimmedQueueName, {
    ...options,
    connection,
    prefix
  })
}
