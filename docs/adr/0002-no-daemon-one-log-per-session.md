# No daemon, one log per Session

Adapters are short-lived commands run by runtime hooks: they append Events to one log file per
Session and answer policy from a file, and `status` derives state on read. Trades live notification
and live stall detection for nothing-to-keep-running and single-writer files that parallel Sessions
never contend on; a notifier can come later as one more reader of the same logs.
