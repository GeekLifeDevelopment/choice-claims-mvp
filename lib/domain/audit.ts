export type AuditAction =
  | 'claim_created'
  | 'duplicate_blocked'
  | 'duplicate_replay_ignored'
  | 'vin_lookup_enqueued'
  | 'vin_lookup_requeued'
  | 'vin_data_fetched'
  | 'vin_data_fetch_failed'
  | 'intake_validation_failed'
