export const JOB_NAMES = {
  LOOKUP_VIN_DATA: 'lookup-vin-data'
} as const

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES]
