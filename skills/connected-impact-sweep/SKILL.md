---
name: connected-impact-sweep
description: "Use this whenever asked to edit, fix, refactor, or add to code that lives inside an existing multi-file project or system — not just an isolated snippet. Default to this for essentially any edit task, changing the goal from making the requested change compile/pass to making the requested change without leaving the surrounding system incoherent. Always check this before editing a schema, DTO, Pydantic model, TypeScript type, OpenAPI contract, public API/endpoint/CLI behavior, generated/artifact file, config key, env var, dependency-injection seam, cross-language boundary, shared domain model, state-update path, test fixture/golden file/benchmark baseline, or a CUDA/numerical kernel's input-output behavior — these are the cases where a locally-correct patch quietly breaks something two files away. Also trigger on explicit phrases like 'connected-impact sweep,' 'robust connected-impact fix,' or 'don't just patch this locally.'"
---

# Connected-Impact Sweep

## Why this exists

The default failure mode when editing code inside a real system isn't "the edit was wrong" — it's "the edit was locally correct and globally incoherent." A schema field gets renamed and the edit compiles, but three other places still serialize the old name. A function's return contract changes and the caller is updated but the golden-file test wasn't. A CUDA kernel gets vectorized and the CPU fallback path silently diverges. Each of these looks like a successful, complete edit in isolation. The break only shows up later, as "the next obvious thing that's broken" — someone else's problem, on someone else's clock.

The fix isn't to audit everything, every time — that's slow, expensive, and mostly wasted effort on edits that really are self-contained. The fix is to size the check to the risk: a fast, cheap look for every edit, and a real sweep only when the edit touches something with fan-out.

## Level 1 — Always-on lightweight check (every edit, no exceptions)

Before touching any file that's part of a larger project, spend a few seconds answering, out loud in your own reasoning, not to the user:

- What directly imports, calls, or reads this file/function/schema/path?
- Is there an obvious test, doc, config, or sibling implementation (e.g., a TS type that mirrors this Python model) that has to move in lockstep with this change?

If the answer is "nothing, this is self-contained" — proceed exactly as you normally would. Don't manufacture a report or announce that you checked. This step should be invisible when it comes back clean.

If the answer surfaces one or two obvious dependents, fix them together with the primary edit, in the same turn, without being asked twice. This is still Level 1 — a grep and a fix, not an investigation. Mention briefly what else you touched and why, in a sentence, not a section header.

## Level 2 — Automatic full sweep

Escalate to a full sweep automatically — don't wait to be asked — when the edit touches any of these, because they're exactly the categories where a shallow fix creates downstream breakage:

- Schema / DTO / Pydantic model / TypeScript type / OpenAPI contract
- Public API, endpoint, or CLI behavior
- Artifact path, generated file, or pipeline output
- Config key, env var, or dependency-injection seam
- A cross-language boundary (anywhere the same shape is defined twice, once per language)
- Shared domain model or state-update path
- Test fixture, golden file, or benchmark baseline
- CUDA/numerical kernel input-output behavior
- A hand-maintained mirror of real logic used for testing across a language boundary (a stub, fake, or mock that reimplements another system's behavior rather than calling it) — these drift silently because nothing forces them to move with the real implementation
- A knowledge/policy/retrieval corpus that the system treats as evidence for its own outputs (RAG source documents, prompt templates, few-shot examples encoding a taxonomy) — these are runtime contract surfaces, not documentation, even though they look like prose

### What the sweep actually does

1. **Enumerate consumers across the whole connected system**, not just the current directory — other services, other languages, docs that describe the contract, generated code that would now be stale, tests that assert the old behavior. Use search (grep/ripgrep, or the project's own reference-finding tools) rather than guessing from memory. This step must go beyond static imports/callers: also check config files, service/plugin registries, build/deploy scripts, generated manifests, and any string- or dotted-path-based reference (dynamic imports, reflection, `getattr`-style dispatch). A dependency that's only reachable through a config string is still a dependency, and static-analysis-shaped searches miss it by construction.
2. **Classify each hit**: needs updating now, needs the user's eyes because it's ambiguous, or genuinely unaffected. Don't pad the list with unaffected files just to look thorough. A dependent that only reads or passes through a value generically (an untyped string field, a generic formatter, a passthrough serializer) is genuinely unaffected by adding a new possible value — don't patch it just because grep found it. The real risk sits one layer deeper: search specifically for hardcoded comparisons against a value's *specific contents* (`== "some_literal"`, `.equals("some_literal")`, a `switch`/`match` on known cases) rather than its shape — those are the places a new case can be silently invisible to logic that still compiles and still runs, just wrong.
3. **Apply the coherent set of changes together** — the requested edit plus everything in "needs updating now" — as one unit of work. A schema rename that updates the schema but not its three serializers isn't done; it's half done with a different bug.
4. **Update mirrored definitions and regenerate stale artifacts**: if a Pydantic model has a hand-mirrored TS interface, move both. If something is generated from a source of truth (OpenAPI spec, proto file, schema), regenerate rather than hand-patching the output.
5. **Report what moved and why**, sized to what actually happened — a short list is fine, don't inflate it into a formal audit document unless the user asked for one.

### Don't overreach

The sweep finds and fixes the dependency graph of the requested change — it does not become a license to refactor unrelated code, rename things for style, or "clean up while you're in there." Keep the diff to what coherence actually requires. If you notice unrelated issues, mention them briefly at the end rather than fixing them unasked.

### Staged edits vs. completed edits

A change can be mechanically trivial and still not be *done*. Adding a member to an enum is one line. But if that enum drives classification logic, escalation routing, cross-language contract checks, evaluation baselines, or a knowledge corpus the system cites as evidence for its own decisions — the one-line addition doesn't mean the feature works, or even that it's safe to leave half-finished. When a mechanical edit sits inside a chain of unresolved pause-worthy questions (see below), report it as a **proposed/staged edit**, not a completed fix: "I've drafted the enum addition, but it isn't functional yet — here's what has to be resolved before it is." Don't let the smallness of the diff imply the largeness of the remaining work is optional or already handled. The test for "is this actually done" is whether every surface that gives the new state *meaning* — not just every surface that would fail to compile without it — is coherent.

## When to pause instead of deciding

Most of the time, once the sweep identifies what needs to change, just make the changes — that's the point of defaulting to coherence instead of defaulting to asking. But pause and lay out the fork for the user, rather than picking silently, when the ambiguity specifically concerns:

- **A public/external contract** — something external callers, other teams, or other systems depend on. Pause unless the task itself explicitly says the point is to change that contract (e.g., "add a new field to the public API response") — in that case the contract change is the request, not an ambiguity, and doesn't need re-litigating.
- **Data schema or architecture direction** — more than one reasonable shape, not just more than one reasonable variable name.
- **Migration, default, or backfill behavior** — how existing data/state (already-written records, already-generated artifacts, already-classified examples) should be treated once the new shape exists. This includes cases with no explicit "migration" framing at all — e.g. adding a new value to a controlled vocabulary raises exactly this question for every record already classified under the old vocabulary, even though nothing is literally being migrated in the traditional sense.
- **Deleting or retiring code that's still reachable.**
- **A numerical correctness expectation** — what the "right" answer actually is, not just how to compute it.
- **GPU/CPU equivalence behavior** — whether a fast-path and a fallback are supposed to agree bit-for-bit, approximately, or not at all.
- **Security or production safety.**
- **Escalation or safety-relevant routing logic that differs across a language or service boundary** — e.g. a hardcoded string/value comparison on one side of a boundary that gates escalation, authorization, or safety behavior. Whether a new state should trip the same routing as an existing one is a semantics question, not a mechanical translation, even though the fix looks like "just add the same comparison on the other side."

These are hard-pause categories: don't resolve them with a judgment call and a footnote, actually stop and ask. Outside of these, resolve the ambiguity yourself and note the call you made — don't turn every sweep into a round of clarifying questions. The whole point is to be more autonomous about coherence, not less autonomous about everything.

### Golden files and fixtures — a narrower rule

Golden files, expected-output fixtures, and benchmark baselines get their own rule because "update it to match" and "pause" are both wrong by default:

- If the task **explicitly says** the point is to change behavior (e.g., "make the sort descending instead of ascending"), regenerating the golden file to match is expected — do it, but flag it clearly so it's never a silent diff ("regenerated golden file X to reflect the requested behavior change").
- If the task **did not** say anything about changing behavior, and the sweep discovers that existing goldens would now come out different, that's a signal of an unintended regression, not a green light to update the baseline. Pause before touching goldens in that case — don't quietly make the test pass again by moving the target.

## Verification before claiming completion

Don't assert that something is now coherent — show that it is. "I checked and nothing else references this" is only true if you actually ran the search; "the tests should still pass" is a guess unless you ran them. Before reporting a sweep as complete (or a staged edit as staged), do the actual verification the situation calls for and cite what you ran and what it returned:

- Re-run the search that built the blast-radius map, so the report reflects what's actually in the repo, not what you assumed was there.
- If a test suite, linter, or eval harness exists and is runnable in the current environment, run it and report the result rather than predicting it.
- If something can't be verified in this environment (no test runner available, a live system you can't reach), say so explicitly rather than implying it was checked — "I couldn't run the Java test suite here; run `./gradlew test` before merging" is honest, "this should work" is not.

This matters most for staged edits: the whole point of flagging something as staged rather than complete is that its correctness is unverified. Don't let a confident summary at the end quietly undo that distinction.

## Level 3 — Explicit override

If the user says something like "use parallel connected-impact sweep" or "do a robust connected-impact fix, not a local patch," run the full Level 2 sweep regardless of what Level 1's quick check suggested — treat it as an instruction to check harder than your own judgment would, not a suggestion.

## A note on scale

This skill is deliberately general-purpose — it isn't tied to one repo's conventions. On any given project, the concrete mechanics (how to find consumers, what "generated" means, where golden files live) will differ. Use whatever the project already provides: its build tooling, its test runner, its own docs about its own architecture. The skill's job is to make you look; the project supplies what you're looking at.
