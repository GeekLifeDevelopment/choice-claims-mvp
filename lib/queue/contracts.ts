import { JOB_NAMES, type JobName } from './job-names'
import type { JobPayloadByName } from './job-payloads'
import { QUEUE_NAMES, type QueueName } from './queue-names'

export const JOB_QUEUE_BINDINGS = {
  [JOB_NAMES.LOOKUP_VIN_DATA]: QUEUE_NAMES.VIN_DATA
} as const satisfies Record<JobName, QueueName>

export type QueueNameByJobName = typeof JOB_QUEUE_BINDINGS

export type QueueForJob<TJobName extends JobName> = QueueNameByJobName[TJobName]

export type QueueJobContract<TJobName extends JobName> = {
  jobName: TJobName
  queueName: QueueForJob<TJobName>
  payload: JobPayloadByName<TJobName>
}

export function getQueueNameForJob<TJobName extends JobName>(jobName: TJobName): QueueForJob<TJobName> {
  return JOB_QUEUE_BINDINGS[jobName]
}
