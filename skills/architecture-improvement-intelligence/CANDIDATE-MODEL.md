# Architecture Candidate Model

ICA V2 is broader than a deep-module detector. Deep modules remain a primary design vocabulary, but the correct transformation is whichever best improves structural ownership, locality, leverage, and conceptual burden under current constraints.

## Transformation kinds

- `deepen_merge` — consolidate tightly coupled behavior behind a narrower, more powerful interface;
- `split_authority` — separate unrelated lifecycles/policies that are artificially centralized;
- `relocate_seam` — move a boundary to the actual authority edge;
- `eliminate_false_seam` — remove a layer/interface that adds indirection without leverage;
- `inline_shallow_wrapper` — collapse a pass-through module when deletion concentrates understanding rather than complexity;
- `consolidate_state_owner` — give one module canonical authority for state/transitions/invariants;
- `invert_dependency` — reverse dependency direction so volatile/detail code depends on the stable owner/contract;
- `isolate_adapter` — contain integration/runtime variability behind a real seam;
- `remove_parallel_path` — eliminate duplicate execution/persistence/policy routes;
- `retain_current_structure` — explicitly reject structural change when alternatives fail the critic.

## Required candidate fields

The canonical schema is `assets/architecture-candidate-set.schema.json`. A surviving candidate records:

- stable `candidate_id` and title;
- transformation kind;
- evidence references;
- structural problem;
- current and proposed state;
- authority before/after;
- interface/locality/leverage change;
- complexity destination;
- deletion-test result;
- cheaper/simpler alternative;
- risks, compatibility, migration;
- verification obligations;
- critic receipt;
- canonical ledger reference/score where eligible;
- unresolved decisions and routing disposition.

The candidate set, not the HTML report, is the canonical architecture artifact.
