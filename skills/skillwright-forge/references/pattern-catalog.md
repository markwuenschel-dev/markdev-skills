# Pattern Catalog

Read this file after the task contract is known. Choose one primary pattern and add supporting patterns only when they close a specific failure mode.

## Selection matrix

| Need | Primary pattern | Core artifact | Main risk |
|---|---|---|---|
| Supply durable conventions or domain knowledge | Reference wrapper | `references/*.md` | Weak routing or excessive reference loading |
| Produce a stable output structure | Generator | `assets/*` plus style reference | Template rigidity or hidden required fields |
| Evaluate existing work against a standard | Reviewer | Checklist plus review protocol | Subjective severity or incomplete coverage |
| Gather essential context before acting | Inversion | Question/answer gate | Excessive questioning or stalled execution |
| Enforce dependent steps | Pipeline | Ordered steps with gates | Skipped validation or premature completion |
| Use a changing local CLI | Runtime-help CLI | Live help plus durable workflow | Stale copied syntax or silent setup |
| Combine independent capabilities | Router/composition | Child-skill pointers and handoff contracts | Context bloat or unsafe composition |
| Make fragile operations repeatable | Code-as-skill | Tested tiny script | Supply-chain, permission, or sandbox risk |

## 1. Reference wrapper

Use when the agent already knows how to perform the broad task but lacks durable local rules, schemas, naming conventions, or decision heuristics.

Keep `SKILL.md` focused on activation and the moment at which the reference must be loaded. Avoid scripts and templates unless they solve a separate concrete need.

Completion test: the skill changes decisions because of the reference; it is not merely a bookmark.

## 2. Generator

Use when structural consistency matters more than free-form output shape.

Place the required skeleton in `assets/`. Keep tone, terminology, and conditional content rules in `references/`. State which fields are immutable, required, optional, or derived.

Completion test: two valid outputs may differ in content but share the required structure and validation properties.

## 3. Reviewer

Use when the task is “assess against a rubric.” Separate:

- **what to check**: the checklist or standard;
- **how to check**: evidence collection, severity, reporting, and stopping rules.

Require evidence for every finding. Group findings by impact, not by discovery order. Define the difference between error, warning, accepted risk, and informational improvement.

Completion test: every applicable rule was evaluated, every finding points to evidence, and the report distinguishes confirmed defects from uncertainty.

## 4. Inversion

Use only when missing user-specific information materially changes the activation boundary, permissions, success condition, or output contract.

Ask the smallest grouped set of high-value questions. Reuse available files, environment state, and prior answers before asking. Provide sensible defaults for low-risk preferences.

Gate: begin execution once the required facts are resolved; do not turn ordinary implementation choices into user interviews.

## 5. Pipeline

Use when step order is a correctness property.

Each stage should define input, action, artifact, validator, failure behavior, and gate. Prefer plan → validate → execute → verify for batch, destructive, or high-stakes work.

Completion test: skipping any gate makes the run visibly invalid rather than silently incomplete.

## 6. Runtime-help CLI

Use when a local command-line interface is the authoritative execution surface and its syntax may change. Where the check is cheap and read-only, prefer resolving it via `` !`command` `` dynamic context injection so the rendered skill carries live output instead of the agent re-running a probe step each time.

Keep in the skill:

- user intents and non-goals;
- environment and artifact conventions;
- read-only-first defaults;
- approval and permission rules;
- help-probe command families;
- failure, verification, and handoff behavior.

Keep out of the skill:

- full manuals;
- copied flag inventories;
- remembered defaults;
- hidden install or authentication commands.

Completion test: every used command shape was verified from the installed CLI or current authoritative documentation, and missing setup caused an explicit stop.

## 7. Router and composition

Use when independently invocable capabilities need orchestration.

Define for each child:

- applicability boundary;
- input and output contract;
- permission boundary;
- success and failure return state;
- what context the parent must pass;
- what context the child should not inherit.

For a child that should run isolated from the parent conversation, give it `context: fork` and an `agent:` (built-in `Explore`/`Plan`/`general-purpose`, or a custom type from `.claude/agents/`); the forked subagent receives the child skill's body as its entire prompt and no conversation history, so `context: fork` only fits a child with an explicit task, not one that's pure reference material. For a child that should run inline and share context, invoke it as an ordinary model- or user-invoked skill and let the parent's instructions name when to reach for it — Claude Code does not document skill-to-skill invocation as a first-class mechanism, so treat "the parent tells Claude to use skill X next" as a prompting convention, not a guaranteed call.

Composition forms include serial, conditional, parallel, and recursive execution. Prefer the simplest form. Validate interactions, not just each child in isolation.

Completion test: the parent can resume correctly after every child success, failure, or escalation.

## 8. Code-as-skill

Use when deterministic execution materially improves reliability, efficiency, or verifiability.

Keep scripts small, inspectable, dependency-light, and sandbox-compatible. Validate inputs before side effects. Emit machine-readable output when another step consumes it. Pin or verify dependencies and record provenance.

Completion test: traditional tests can verify the script and the skill still defines when and why to run it.

## 9. Advanced patterns

### Self-evolving library

Use only with human review, versioning, rollback, deterministic evaluation, provenance, and promotion gates. Treat generated skill revisions as untrusted candidates. Curated skills are the default production path.

### Meta-skill

Use only when a skill must create, modify, or compose other skills at runtime — this is what Skillwright Forge itself is. Enforce the same contract, security review, and evaluation gates as human-authored skills. Keep autonomous publication disabled unless the user explicitly authorizes it: writing a new `SKILL.md` into `~/.claude/skills/` or a project's `.claude/skills/` is an installation action, not a draft edit, and takes effect live (Claude Code watches skill directories for changes within the current session).

### Marketplace distribution

Treat distribution as a governance layer, not a guarantee of quality. Require package integrity, version pinning, source review, trust tier, permission declaration, and update policy.

## Composition warning

Patterns are non-exclusive, but adding patterns increases context, interfaces, and attack surface. Add a pattern only when it has a named failure mode, an observable benefit, and an evaluation that proves the benefit.
