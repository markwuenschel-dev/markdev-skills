# Authoring Standard

Read this file when creating or materially revising a skill. Treat it as the normative writing standard for Skillwright Forge, targeting Claude Code specifically (see the [Claude Code skills docs](https://code.claude.com/docs/en/skills.md) for the primary source; re-check it periodically since features gate on Claude Code version numbers).

## 1. Root quality: predictable process

A skill improves a stochastic agent by making its process predictable, not by forcing identical outputs. Creative tasks may vary in content while still following the same discovery, drafting, review, and completion process.

Use **contract** as the leading concept throughout a skill:

- discovery metadata is the applicability contract;
- ordered instructions are the policy contract;
- completion criteria are the termination contract;
- inputs, outputs, tools, and permissions are the interface contract.

## 2. Invocation design

Choose invocation intentionally.

### Model-invoked

Use when the agent must discover the skill autonomously or another skill must route to it. The description is always-loaded routing context, so every word must earn its cost.

A strong description:

1. starts with the leading capability;
2. names the output or task domain;
3. states user-visible trigger conditions;
4. names the closest non-goals;
5. omits body-level workflow details.

### User-invoked

Use when a workflow has a side effect or timing only the user should control (a deploy, a commit, a message send) or the skill is too specialized to justify permanent routing context. Set `disable-model-invocation: true`; the skill then runs only via `/<skill-name>` (the directory name, not the frontmatter `name`), never automatically. This also keeps it out of subagent preload and scheduled-task firing. Use `user-invocable: false` for the inverse — background knowledge Claude should apply but that isn't a meaningful command for a user to run directly.

### Router

Use a router when many user-invoked skills create excessive human recall burden. The router should identify the relevant child skill; it should not duplicate each child's procedure. For a child that must run isolated from the main conversation (its own context, its own tool budget), set `context: fork` with `agent:` set to a built-in agent (`Explore`, `Plan`, `general-purpose`) or a custom type from `.claude/agents/` — this only suits a child with an explicit task, since a forked subagent gets the skill body as its entire prompt and no conversation history.

## 3. Information hierarchy

Rank content by when the agent needs it:

1. ordered steps in `SKILL.md`;
2. universally needed reference in `SKILL.md`;
3. branch-specific reference behind a precise context pointer;
4. fixed templates in `assets/`;
5. deterministic execution in `scripts/`.

Inline what every branch needs. Disclose what only one branch needs. A context pointer must state the condition for loading its target, not merely name the file.

Good:

> For destructive or externally visible actions, read `references/security-governance.md` before planning the write.

Weak:

> See `references/security-governance.md`.

Keep support files exactly one directory below the skill root. Prefer `references/policy.md`, not `references/security/policy.md`.

## 4. Degrees of freedom

Match specificity to the cost of variance.

### High freedom

Use principles and heuristics when several solutions are valid and context determines the best one. Require observable outcomes, not a fixed internal route.

### Medium freedom

Use pseudocode, templates, parameterized scripts, or a preferred sequence when the structure should remain stable but details vary.

### Low freedom

Use exact scripts, schemas, flags verified from a live source, and strict gates when an operation is fragile, repetitive, security-sensitive, or hard to reverse.

A skill can mix degrees of freedom by step. Do not make the entire skill rigid merely because one operation is fragile.

## 5. Steps, branches, and completion criteria

Write steps in chronological order. Each major step should contain:

- the action;
- branch conditions;
- required inputs or references;
- produced artifact or state change;
- failure or escalation behavior;
- a checkable completion criterion.

A completion criterion should be both clear and demanding. Prefer “every modified file is validated and listed” over “review the changes.”

Use a gate when later work becomes invalid if the current step is incomplete. If a step is repeatedly rushed despite a sharp criterion, split the sequence so later steps are not in the active context.

## 6. Language rules

- Use third-person imperative commands: “Inspect,” “Run,” “Record,” “Stop.”
- Use one term for one concept.
- Co-locate definitions, rules, caveats, and error handling.
- State positive target behavior first.
- Keep hard prohibitions only for safety or contract boundaries, and pair them with the correct alternative.
- Prefer one default plus one escape hatch.
- Use examples as tests or structural constraints, not decoration.
- Use forward-slash relative paths.
- Keep `SKILL.md` below 500 lines.

## 7. Pruning tests

Apply these tests sentence by sentence.

### Relevance

Does the sentence affect the skill's current capability? Remove historical or adjacent material that does not.

### No-op

Would a capable model behave the same without the sentence? Remove it or replace it with a stronger, observable instruction.

### Duplication

Does the same meaning exist elsewhere? Keep one source of truth and replace duplicates with a context pointer.

### Sediment

Is the sentence present only because deletion feels risky? Verify its current use and remove it when unneeded.

### Sprawl

Is the file long even though each line is live? Move branch-specific reference down the information hierarchy or split a genuinely independent capability.

### Negation

Does a prohibition activate the unwanted behavior more strongly than the target behavior? Rewrite positively. Retain the prohibition only when it marks a hard boundary.

## 8. Frontmatter contract

All fields are optional in Claude Code; only `description` is recommended. Nothing below is enforced by the platform except where noted — most of it is this skill's own convention for clarity and predictability.

| Field | Purpose | Note |
|---|---|---|
| `name` | Display label in skill listings | Defaults to the directory name; the directory name is what the user actually types after `/`. Keep them identical anyway. |
| `description` | Routing signal for model-invoked activation | Falls back to the first markdown paragraph if omitted — write it explicitly. Third person, leads with capability, states trigger and nearest non-goal. |
| `when_to_use` | Extra trigger phrases | Appended to `description` in the listing; combined text truncates at **1,536 characters**. |
| `argument-hint` | Autocomplete hint for expected arguments | E.g. `[issue-number]`. |
| `arguments` | Named positional args for `$name` substitution | Space-separated string or YAML list; maps to `$ARGUMENTS[N]`/`$N` by position. |
| `disable-model-invocation` | `true` restricts to user-only invocation via `/name` | Also blocks subagent preload and scheduled-task firing. Default `false`. |
| `user-invocable` | `false` hides from the `/` menu; Claude can still load it | Default `true`. |
| `allowed-tools` | Pre-approves listed tools while the skill is active | Space/comma-separated or YAML list; project-scoped skills need workspace trust first. |
| `disallowed-tools` | Removes listed tools while the skill is active | Clears on the user's next message. |
| `model` / `effort` | Override for the current turn | `effort` accepts `low`/`medium`/`high`/`xhigh`/`max`. |
| `context: fork` / `agent` | Runs the skill as a forked subagent | `agent` picks the subagent type; ignored without `context: fork`. |
| `hooks` | Skill-scoped lifecycle hooks | See Claude Code hooks docs for shape. |
| `paths` | Glob patterns restricting auto-activation to matching files | Comma-separated string or YAML list. |
| `shell` | Shell for `` !`command` `` injection | `bash` (default) or `powershell`. |

Do not invent a field beyond this table without confirming it against current Claude Code documentation — the platform silently ignores unrecognized keys rather than erroring, so a typo or an invented field fails quietly.

## 9. Resource rules

### References

Use for durable knowledge the model cannot reliably infer or retrieve from a live authoritative source. Structure long reference files with clear headings and a short contents section when navigation benefits.

### Assets

Use for fixed output shapes, schemas, checklists, and starter files. Tell the agent whether to copy exactly or adapt specified fields.

### Scripts

Use tiny command-line utilities for fragile or repetitive operations. Scripts should:

- accept explicit inputs;
- produce deterministic outputs where feasible;
- validate preconditions;
- handle expected failures;
- write actionable errors to stderr;
- return documented exit codes;
- avoid hidden installation, authentication, network access, and destructive side effects;
- justify retry counts, timeouts, thresholds, and other constants.

Make clear whether a script is executed or read. Prefer execution for utilities.

## 10. Volatile interfaces

Do not copy a changing CLI or API manual into a skill. Where the volatile fact is cheap to compute, prefer Claude Code's dynamic context injection (`` !`command` `` inline, or a fenced ` ```! ` block for multi-line) so the rendered skill always carries current output — a live `git diff`, `--version` string, or `--help` summary — resolved once, before Claude reads the skill, rather than re-derived by the agent each run.

For a local CLI with good help and no injection in place:

1. verify the executable and environment;
2. read root help;
3. read relevant subcommand help;
4. run the smallest read-only probe;
5. preview writes when supported;
6. execute only within the approved boundary;
7. report commands, outputs, and artifacts.

Use the installed interface as the syntax source of truth and the skill as the workflow-policy source of truth.

## 11. Final quality test

The body is ready when a fresh agent can answer all of these without guessing:

- Why did this skill activate?
- Which branch applies?
- What is the next action?
- Which source is authoritative?
- What may be changed?
- What requires approval?
- What artifact proves progress?
- What condition means success?
- What condition means stop or escalation?
