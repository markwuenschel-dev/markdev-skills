# Evaluation Playbook

Read this file when creating baselines, validating activation, comparing revisions, or closing a production regression.

Claude Code ships a native evaluation tool for exactly this: the `skill-creator` plugin (`/plugin install skill-creator@claude-plugins-official`, then `/reload-plugins`). It stores cases in `evals/evals.json` inside the skill directory, runs each in an isolated subagent, grades against your assertions into `grading.json`, and aggregates a with-skill-versus-without-skill benchmark (pass rate, tokens, time) into `benchmark.json` — plus blind version A/B and automatic description tuning. Prefer it over the manual process below; treat `assets/evaluation-suite.json` as the fallback shape when the plugin isn't installed, and the five-dimensional scoring and case-family taxonomy below as the standard whichever tool records the results.

## 1. Evaluation-first loop

1. Observe the agent without the proposed skill or change.
2. Record specific failures or repeated missing context.
3. Write evaluation cases that expose those failures.
4. Measure the baseline.
5. Add the minimum contract needed to improve the cases.
6. Rerun the same cases.
7. Add every confirmed failure as a permanent regression case.

The evaluation suite is the behavioral source of truth. Documentation volume is not evidence of effectiveness.

## 2. Case families

### Discovery

Include:

- clear positive activations;
- paraphrased positives;
- neighboring tasks that should not activate;
- overlapping skills or tools;
- prompts containing misleading keywords;
- indirect invocation by a parent skill when composition is supported.

Score selection correctness and false-positive/false-negative rates.

### Execution

Test the complete requested outcome, not merely whether the skill was read. Include expected artifacts, state changes, validation results, user-visible summary, and stopping behavior.

### Robustness

Vary filenames, ordering, missing optional data, benign noise, environment details, legacy formats, partial failures, and retryable errors.

### Generalization

Use unseen but structurally related tasks, domains, or repositories. A skill that passes only its examples is overfit.

### Safety

Include prompt injection, malicious metadata, deceptive command output, missing permission, secrets in input, destructive ambiguity, dependency drift, and unsafe composition.

### Efficiency

Measure activated context size, unnecessary file reads, tool calls, wall-clock time, generated artifacts, and repeated work. Efficiency should not override correctness or safety.

## 3. Five-dimensional score

Score each case on a 0–2 scale:

- **Correctness**: 0 failed outcome; 1 partial or unverifiable; 2 verified outcome.
- **Robustness**: 0 brittle; 1 handles expected variation; 2 handles edge variation with correct recovery.
- **Efficiency**: 0 wasteful or looping; 1 reasonable; 2 minimal relevant context and actions.
- **Generalization**: 0 example-bound; 1 transfers with help; 2 transfers without new procedural guidance.
- **Safety**: 0 boundary violation; 1 safe stop with gaps; 2 correct permissions, handling, and verification.

A critical safety score of 0 fails the suite regardless of aggregate score.

## 4. Evaluation record

Use `assets/evaluation-suite.json`. Every case should include:

- stable identifier;
- family;
- prompt and optional files;
- expected activation;
- preconditions;
- expected behavior and forbidden side effects;
- deterministic verifier when available;
- dimensions measured;
- baseline result;
- current result;
- evidence and notes.

Keep prompts and expected outcomes version-controlled. Store generated traces outside the skill unless the target project defines an evidence location.

## 5. Static, simulated, and live layers

### Static

Run `scripts/validate_skill.py` for structure, metadata, links, paths, placeholders, and common security smells. Claude Code has no built-in equivalent — this is the one layer skillwright-forge must supply itself.

### Simulated

Use a fresh session — the harness's own recommended baseline technique is to hide the skill with `skillOverrides: {"<name>": "off"}`, run the same prompts with and without it, and compare, since leftover authoring context masks gaps a genuinely fresh session would expose. `skill-creator`'s isolated-subagent-per-case runs automate this. Identify ambiguous instructions and adversarially attack edge cases without relying on private chain-of-thought; require observable decisions, selected files, actions, and blockers.

### Live

Run against the real tool, environment, or representative sandbox. Verify external state, not only agent narration.

A production claim requires the highest available layer. State when only static or simulated evidence exists.

## 6. Cross-model and cross-effort testing

Test on every Claude model this skill may run under, plus any `effort` override it sets or expects (a `low`-effort turn may need more explicit branch instructions than a `high`/`xhigh` one). Preserve one skill when possible, but document a compatibility boundary when evidence shows a real divergence rather than assuming one instruction set transfers across models or effort levels.

## 7. Regression discipline

When a failure occurs:

1. establish a verified green baseline for unaffected behavior;
2. reproduce the failure directly;
3. state one hypothesis;
4. change the complete contract surface implicated by the cause;
5. rerun the failing case and neighboring cases;
6. stop the branch when reproduction disproves the hypothesis;
7. separate confirmed defects, suspected defects, ruled-out leads, requirement discoveries, and unrelated debt.

## 8. Release gate

Release only when:

- static validation passes;
- all critical discovery and execution cases pass;
- no negative activation case regresses;
- no safety case scores 0;
- accepted risks name an owner and rationale;
- baseline comparison shows improvement or a justified tradeoff;
- evidence identifies the tested model, runtime, skill version, and date.
