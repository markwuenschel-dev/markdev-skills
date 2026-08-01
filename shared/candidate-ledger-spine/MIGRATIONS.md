# Candidate-ledger spine migration

This package is the sole physical owner of spine version 3. It consolidates the written scoring contract formerly under `codebase-integrity-audit-loop/REPORT-SCORING.md` and the executable verifier formerly under `improve-codebase-architecture-mwdev/assets/ledger-verify.js`.

Consumers resolve `shared/candidate-ledger-spine/ledger-verify.js` repository-relatively, or use the explicit `LEDGER_VERIFY_PATH` override. Missing or incompatible code is a hard failure; consumers must not score, rank, or render an empty candidate panel locally.

New outputs attach `candidate_lifecycle`. Historical top-level `lifecycle_status` and `resolution` may be read only to establish continuity; they are not emitted by new reports.
