# Draft Mode — Single-Task Prompts

One rough idea in, one paste-ready prompt out. The intent contract (SKILL.md Step 2) is already captured; this file governs construction.

## Construction order

Assemble only the blocks the task needs, in this order:

1. **Role** — only for complex or specialized tasks, and only as a professional identity plus domain plus stance ("senior backend engineer specializing in distributed systems who prioritizes correctness over cleverness"). Skip for simple factual or mechanical tasks; a role that doesn't change behavior is dead weight.
2. **Context** — the minimum facts the target cannot infer: project state, stack decisions, audience, what was already tried and failed. When the request references prior session work, compress the established decisions into a short carry-forward block and place it in the first 30% of the prompt.
3. **Task** — one precise operation with a concrete object. "Refactor `getUserData()` to async/await and handle null returns", never "help me with my code". Two unrelated operations = two prompts.
4. **Constraints** — must / must-not, scope boundaries, exclusions from prior failures ("I tried X; do not suggest X").
5. **Output contract** — format, structure, and length, always explicit. "Write a summary" → "3 sentences"; "make it professional" → concrete measurable specs (palette, font size, tone markers). Derive a binary done-condition from the goal when the user gave none.
6. **Examples** — 2–5 input/output pairs only when format is easier to show than describe, or the user has re-prompted for the same formatting issue before. Structurally consistent, realistic, clearly separated from instructions.

## Technique selection

Apply the simplest technique that closes the gap. Default set:

- **Role assignment** — as above; the highest-leverage single line for specialist tasks.
- **Few-shot examples** — format lock and edge-case demonstration.
- **Grounding anchor** — for any factual, citation, or research task: "Use only information you are highly confident is accurate. If uncertain, mark the claim [uncertain]. Do not fabricate citations or statistics."
- **Step-by-step reasoning** — for logic, math, and debugging on standard instruct models only: "Think through this carefully before answering." Never on reasoning-native targets (standing rule 6).
- **Scope lock** — for any IDE or agentic target: file/function anchors, do-not-touch list, done-when condition (see standing rule 8 for the full guardrail set).

Techniques that carry high fabrication risk in a single prompt — simulated multi-persona routing ("mixture of experts"), simulated tree/graph search, self-consistency voting without real independent samples, and long prompt chains as a layered technique — are applied only when the user explicitly requests them and the target genuinely supports them. In a single forward pass they produce theater, not reasoning.

## Attention placement

- Most critical constraints and definitions: first 30% of the prompt.
- Long pasted evidence (documents, code, transcripts): before the ask.
- The actual ask: terminal section, stated once.
- Do not cargo-cult heavy sectioning into short prompts; a three-sentence prompt needs no tags.

## Non-LLM surfaces

Family-level conventions. Per-tool parameter syntax (flags, weights, version switches) is volatile — verify current syntax via web search when the user needs exact parameters, and never invent flags.

| Surface | Durable convention |
|---------|--------------------|
| Image generation | Subject first, then style, mood, lighting, composition. Negative prompt for what must not appear. Keyword-list tools want comma-separated descriptors, not prose; prose-native tools want scene description with foreground/midground/background separated. Editing an existing image: instruct the user to attach the reference, then prompt the delta only — what changes, what stays. |
| Video generation | Direct it like a film shot: subject action, camera movement (static/dolly/crane), shot type, lighting, duration. Camera movement is the highest-variance lever. |
| Voice/audio | Specify emotion, pacing, emphasis targets, and pauses directly as parameters or markers; prose mood descriptions do not translate. |
| 3D asset generation | Style keyword + subject + key features + material + texture detail + technical spec (poly budget, export format, A/T-pose if rigging). Use the negative field: "no background, no base, no floating parts." |
| Workflow automation | Trigger app + event → action app + action + field mapping, numbered step by step. Note auth assumptions explicitly: "assumes [app] is already connected." |
| Code completion (inline) | Write the exact signature, docstring, or comment immediately above the cursor: input types, return type, edge cases, and what the function must not do. Completion engines complete what they predict, not what you intend. |
| Browser/computer-use agents | Describe the outcome and constraints, not the click path. Permission boundary ("research only — no purchases") and confirmation gate before any submit/transaction/message are mandatory. |

## Delivery reminder

One copyable block; `Target:` line; setup note only when genuinely needed. Placeholders like `[AUDIENCE]`, `[TONE]`, `[BRAND VOICE]`, `[PRODUCT NAME]` only in content/copy prompts where the slot is truly user-variable.
