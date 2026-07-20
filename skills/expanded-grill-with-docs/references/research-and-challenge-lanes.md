# Research and challenge lanes

Load this reference when the change needs parallel research, specialist challenge, or a large repository map.

Use no more lanes than the uncertainty map justifies. A strong default ceiling is eight primary lanes. Give each lane a bounded question set, permitted surfaces, required evidence, and return contract. Subagents may work beneath a lane, but the parent owns synthesis and conflict resolution.

## Primary lanes

1. **Product and user outcome** — intended behavior, affected users, value, exclusions, adoption, and success evidence.
2. **Domain and terminology** — canonical terms, entities, state transitions, invariants, policy meaning, and ambiguous synonyms.
3. **Repository and current system** — existing boundaries, instructions, contracts, runtime behavior, debt, active changes, and constraints.
4. **Technical and architecture** — mechanisms, component boundaries, dependencies, performance, failure modes, and architectural tradeoffs.
5. **Data, API, schema, and migration** — data ownership, compatibility, versioning, migration shape, invalid states, and recovery.
6. **UX and operational workflow** — human steps, operator paths, usability, accessibility, support burden, and exception handling.
7. **Risk, security, and failure mode** — threats, privacy, policy, abuse, unsafe states, blast radius, and rejected assumptions.
8. **Verification, rollout, and observability** — proof surfaces, testability, instrumentation, rollout cohorts, halt signals, and rollback evidence.

## Lane return contract

Each lane returns:

- questions answered and still open;
- evidence with source and confidence;
- relevant requirements and invalid states;
- decisions requested from the human owner;
- design implications and challenged assumptions;
- risks, falsification signals, and recommended proof surfaces;
- conflicts with other lanes.

## Composition rules

Use `$grill-with-docs` for focused evidence-backed questioning when installed. Use `$wayfinder` or explorer subagents when the repository is too large for one pass. Use domain-modeling, codebase-design, design-it-twice, research, or prototype procedures only when their installed contracts match the active lane. Optional BMAD research or PRFAQ procedures may challenge the proposal, but they do not own the lifecycle or approval.

Treat every child result as evidence, not authority. The parent reconciles terminology, contradictions, permissions, and ownership before updating durable artifacts. When a named skill is unavailable, execute the bounded lane directly and record the missing accelerator as a limitation rather than inventing its interface.
