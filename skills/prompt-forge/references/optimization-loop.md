# Optimize Mode — Eval-Driven Refinement

For refining an existing prompt against evidence, or disciplining iteration on a hard first draft. Never edit before defining what better means.

## Inputs

Collect before iterating: current prompt (or draft) · target model family and snapshot · representative eval cases · scoring rubric · known failures · hard constraints (latency, verbosity, safety, budget, tool use). If success criteria or examples are missing, build a small eval set first — 5–10 cases for a quick pass, at least one held out. If the user has real failure transcripts, they are the seed cases.

## The loop

1. **Baseline.** Run the current prompt on a representative slice. Score at minimum: instruction following, output shape, tool behavior, refusal/escalation correctness, verbosity, robustness on ambiguous inputs, and cost or tool-call efficiency when they matter. Keep a structured evidence pack per run: prompt version, case, output, relevant trace, failure reason, scores.
2. **Cluster failures by root cause** before editing: ambiguity · missing constraints · conflicting rules · bad example fit · weak tool instructions · weak stop conditions · provider mismatch · prompt bloat / duplicated rules. Never patch failing cases one by one when they share a cause.
3. **Write textual gradients** — concrete directional edit criticisms ("Clarify when to ask before acting", "Separate retrieved context from instructions", "Replace anti-pattern examples with positive demonstrations"). Not "make it better."
4. **Generate a candidate beam**, 2–4 candidates: minimal-diff repair · structure-first rewrite · examples-first or tool-rule-centered variant · provider adapter when the mismatch is family-level. Always keep one low-risk candidate so you can tell whether the larger rewrite actually helped.
5. **Compare on the same slice.** Identical cases for every candidate; scores from different inputs are not comparable.
6. **Keep a reflective log** — one row per round: hypothesis · edit · result · keep? Record deletions and compaction, not just additions; the log prevents re-trying edits that already failed.
7. **Holdout validation.** Test the winner on held-out cases, replay the original failures, and verify happy-path behavior did not regress.
8. **Stop** on: plateaued scores · oscillation between two behaviors · remaining failures caused by model or tool limits · clear overfit to the eval slice · rising cost without quality gain. Report the plateau and the best candidate rather than grinding.

Edit one or two causal dimensions per round. Optimize examples, tool descriptions, and output contracts alongside the core prompt text — tool-use failures are often schema/description problems that prompt prose cannot fix. For repeated optimization of the same prompt, keep fixed train/validation/holdout slices so before-and-after comparisons stay meaningful; when budget allows, a stronger model can run the optimization pass than the one that will deploy the prompt.

## Not a prompt problem

Say so plainly, before or instead of rewriting, when the bottleneck is: model choice · retrieval quality · tool schema design · missing evals · product requirements conflict. A better prompt cannot fix these, and pretending otherwise burns the user's iterations.

## Escalating to programmatic optimization

When the prompt lives in code, the eval set is large, and iterations are cheap to run, this manual loop has programmatic equivalents worth recommending instead of hand-tuning: declarative prompt-program optimizers that bootstrap demonstrations and tune instructions against a metric (DSPy and its MIPRO-family optimizers), natural-language-gradient methods that backpropagate textual critiques (TextGrad-style), and LLM-as-optimizer trajectory search over instruction candidates (OPRO-style). The manual loop above is the same shape run by hand: score-driven candidate search, explicit critique before revision, reflection memory, holdout validation. Recommend the programmatic route when the user has a metric, a dataset, and a pipeline; keep the manual loop when they have eight examples and a chat window. Verify current library names and APIs before citing specifics — this ecosystem moves fast.

## Return package

Deliver in this order: **Target · Success criteria · External context** (files/paths the prompt depends on, each marked loaded / referenced / out of scope) **· Optimized prompt · Adapter notes · Eval set · Optimization log · Residual risks.** When refining an existing prompt, add a concise diff-style note of the main behavioral changes.
