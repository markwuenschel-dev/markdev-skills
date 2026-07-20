# Production Flywheel — Design Branch Procedure

This is the **default lane (option A)** of the per-item design-lane gate — the lane the assistant runs unless the user explicitly elects the shortcut (option B). "The design seems obvious" is never grounds to skip it. Assume the interface, seam, module shape, and domain language are not yet fully resolved — that assumption is overridden only by an explicit user B election at the gate, never by the design looking finished.

## Steps

1. Run `/grill-with-docs`. This is the default the moment the item reaches its turn in the queue — never skipped on the assistant's own judgment.
2. If multiple interface shapes are plausible, run `/design-it-twice`.

## Required questions

Ask focused questions until these are answered or explicitly deferred:

- Where should the seam live?
- What should the interface hide?
- What behavior proves this module is deeper?
- Which current callers must keep working?
- Which dependencies are in-process, local-substitutable, remote-but-owned, or true external?
- What is out of scope for this slice?
- Would a future maintainer wonder why we chose this shape?
- Does this decision meet the ADR threshold?

## Gate

- **Explicit Direction**: The chosen interface or seam direction is documented explicitly with a brief description of the technical decision.
- **Domain Terms**: Durable domain terms are identified and listed for entry into `CONTEXT.md` during the Capture Audit stage.
- **Architectural Decisions**: Durable architectural decisions are identified and drafted for `docs/adr/` if they meet the ADR threshold.
