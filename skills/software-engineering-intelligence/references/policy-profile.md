# Source-pinned policy profiles

Read this reference when a repository policy document, such as Programming Guidelines, is compiled or interpreted. Policy is repository-specific: do not apply a project-owned guideline to an unrelated repository without explicit adoption evidence.

**Library-only boundary:** policy compilation and evaluation are direct library calls into the shared engine. `run-sei.js` has no policy flag, does not compile or evaluate a policy profile, and no SEI runner artifact carries a policy-profile or Programming Guidelines result. Never claim a policy-profile verdict came from an SEI run.

## First-party Programming Guidelines availability

No normative Programming Guidelines source is bundled with SEI. Repository use is unavailable until the repository supplies an adopted local source, a complete pinned SHA-256 digest, adoption evidence, and exact heading-plus-section-fingerprint locators for every first-party rule. The bundled `programming-guidelines-fixture.js` is test data only and never establishes repository policy.

Call `compileProgrammingGuidelinesProfile` directly (it is not reachable through the runner) in the model-opaque `shared/software-engineering-intelligence/programming-guidelines.js` module for that source-bound branch. It compiles stable rules for layout/namespace, dependency authority, single-owner chokepoints, fail-closed behavior, idempotency, database transactions/locking, testing, generated contracts, secrets/configuration, and delivery. The profile fixes each rule's `hard-invariant`, `required`, `convention`, or `advisory` severity and its `static`, `executable`, `runtime`, `process`, `review`, or `external-evidence` verification mode.

Each located Markdown section must contain exactly one closed machine-readable directive:

```html
<!-- sei-programming-guidelines {"rule_id":"PG-...","mechanic":{"kind":"..."}} -->
```

The compiler verifies the source hash, exact heading, section fingerprint, stable rule identity, closed directive, and repository adoption evidence before emitting the existing closed M2 policy-profile shape. Missing source is unavailable; missing headings, missing fingerprints, directive drift, or source-hash drift fail closed.

## Evaluation contract

Call `evaluateProgrammingGuidelinesProfile` directly, and only after compilation; its result is the library return value, not an SEI runner artifact. It revalidates the profile and re-derives the evaluator oracle from every pinned source section before inspecting the repository. It deterministically evaluates only the supported mechanics: forbidden paths, literal forbidden imports and declared dependencies, sole-owner literal imports, required test/layout paths, generated changed paths with explicit change evidence, and secret/config paths. Missing required evidence yields `unverifiable`; review, runtime, and external-evidence rules remain `unverifiable` rather than being inferred from code structure.

Evaluator input never accepts a caller verdict. A caller-provided `status: pass` is rejected or recomputed from repository evidence. The evaluator emits the same closed M2 policy-profile result shape; it does not create an overall score.

## Generic compilation contract

Call the deterministic `compilePolicy` library boundary directly in `shared/software-engineering-intelligence/policy.js` for other explicitly supplied repository policies. Each structured rule preserves a stable rule ID, source reference, source hash, category, severity, applicability, verification kind, result, and evidence references.

Source-digest mismatch is policy drift. Stop the prior-profile claim and report the rule/profile as unverifiable or failed according to the compiler result; never silently reinterpret changed source Markdown as the pinned policy.

## Reporting contract

Keep `hard-invariant`, `required`, `convention`, and `advisory` results separate. Missing evidence is not a failure by default; retain `partial`, `unverifiable`, and `not-applicable` where supported. A hard-invariant failure remains visible even when other categories contain many passes.

Policy conformance is evidence for the canonical owners. It does not assign a health grade, candidate priority, architecture judgment, lifecycle state, or completion verdict.
