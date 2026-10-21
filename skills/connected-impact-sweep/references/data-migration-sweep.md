# Data and migration sweep

Use for `DATABASE_SCHEMA_CHANGE` or `MIGRATION_CHANGE`.

Trace readers, writers, constraints, indexes, migrations, rollback behavior, seeds, fixtures, and operational tooling. Distinguish new-install behavior from upgrade behavior. Never invent a backfill, default, destructive conversion, or rollback policy: if the request does not settle it, pause. Prefer scratch-state migration verification and test both pre-migration data and fresh state. Golden outputs may move only when the requested behavior intentionally changes.
