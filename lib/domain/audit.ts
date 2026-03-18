export type AuditAction =
  | 'claim_created'
  | 'duplicate_blocked'
  | 'duplicate_replay_ignored'
  | 'vin_lookup_enqueued'
  | 'intake_validation_failed'
