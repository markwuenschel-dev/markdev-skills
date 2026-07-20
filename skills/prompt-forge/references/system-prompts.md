# System Mode — Deployable System Prompts

For persistent system/developer prompts that ship inside an agent product. The entire deliverable is the deployable prompt: assumptions, notes, and open questions live inside it as labeled lines the user can correct, not in surrounding commentary. Switch to findings-then-prompt only when the user explicitly asks for a review or explanation.

Draft in the same turn. Ask a question only when neither the agent's domain nor its primary task can be named from the request; when asking, request the smallest unblocking pair — one concrete sample input the agent would receive, plus what it should return for it. A real example surfaces the job faster than a discovery interview.

## Layered architecture

Default section order; reorder only when the task benefits. Include a layer only when it changes behavior.

1. Role and mission
2. Scope and non-goals
3. Inputs and context boundaries
4. Tool authority and tool-use policy
5. Reasoning and planning policy
6. Output contract
7. Safety, privacy, and compliance
8. Failure handling, uncertainty, and escalation
9. Verification and self-check

## Role definition

A real-world professional identity plus a concrete domain — profession noun (writer, editor, advisor, tutor, analyst, reviewer, strategist) scoped by domain. Reject: product/brand/codename as role ("the Acme growth agent"), pipeline-step labels ("risk-scoring agent", "reminder-copy generation agent"), and generic wrappers ("smart assistant"). "You are the Acme growth agent" → "You are a social-content growth strategist focused on short-video platforms."

## Prompt vs. runtime separation

The deployed agent only sees the words in the prompt. Restate every backend constraint as something the agent reads, decides, says, or refuses — in the agent's own language:

- Drop by default: class/DTO names, snake_case/camelCase field names, pipeline-position words (upstream, downstream, producer, consumer, policy module), backend verbs (enqueue, persist, "structured validation fails"). Keep an exact string only when the user explicitly states the runtime keys on that verbatim string — pasting a schema or JSON sample is not such a statement.
- "`draft.risk_level` must come from upstream" → "Use the alert level given in your input; do not raise or lower it."
- "Don't decide `PushPolicy`" → "You decide only the wording of the reminder. Whether and when it is sent is not your decision."
- "Validation fails when a key input is missing" → "If a required input is missing, say which one and do not produce a draft."

This rewrite applies inside output-contract rows and schema explanations too, not just imperative instructions.

## Layer ownership (multi-owner runtimes)

When the runtime concatenates layers from different owners:

| Layer | Owns | Must not own |
|-------|------|--------------|
| Platform / system | tool policy, output contract, safety, escalation, workflow | voice-only identity |
| Deployer / persona files | voice, tone, domain framing | load-bearing behavior |
| User payload | task facts, variables, the current request | durable policy |

Platform behavior must survive empty or customized persona files. Load-bearing rules go in the highest stable owner; one authoritative owner per rule.

## Tool integration

First classify what the user provided:

- **Broad capability** ("the agent can search the web") → write a short behavior rule, then either ask for the runtime spec or state an explicit interface assumption. Do not invent names, parameters, or return fields.
- **Real runtime spec** (exact name, parameters, return fields) → write an executable tool contract: exact tool name; purpose and decision criteria for calling; required/optional inputs with types; output fields and how to interpret each; missing-input behavior, result-quality checks, conflict handling, fallback.

Never invent the missing half in either direction. Tool schemas stay in the runtime's native tool definitions; the prompt carries policy.

## Reasoning control

Pick one mode: `hidden_reasoning` (default — internal only), `brief_rationale` (short visible rationale/checklist), or `plan_then_answer` (inspectable plan first — only when the workflow needs an intermediate artifact or evaluation requires inspectable state).

## Few-shot calibration

0–1 examples for low-fragility tasks; 2–3 for format-sensitive output; 3–5 for high-stakes or style-critical work. Realistic, structurally consistent, edge-case aware, clearly separated from instructions. If the runtime cannot combine structured output and citations in one response, prompt a two-stage workflow: gather and verify evidence with citations first, then produce the structured answer from verified evidence.

## Safety and compliance standard

Always include, rendered in the deployed prompt's language:

- positive safety boundaries with safe alternatives for high-risk requests (e.g., academic-shortcut requests become tutoring, hints, answer-checking, practice problems)
- PII and sensitive-data handling rules
- source-grounding rules for factual tasks
- prompt-leak resistance for proprietary instructions
- confirmation gates for destructive or irreversible actions
- retention policy when the agent stores, remembers, exports, or modifies user data — set to "unspecified" if the user did not provide one, so the gap is visible

## Sources and templates

Define each external source family (knowledge base, uploaded docs, memory, tool results) before writing retrieval rules: what it is, when it is authoritative, and how to handle missing or conflicting evidence. Add task-specific output templates only for high-frequency workflows — section labels and completion criteria, not policy prose.

## Compactness and revision

Shortest prompt that still covers role, boundaries, tool policy, output contract, safety, and failure handling. State each rule once in its owning section. Localize section headings and labels to the language the deployed prompt is written in.

Revision loop: draft v1 → check for missing role/scope/tool/source/output/safety behavior, repeated rules, and sections that don't change behavior → revise the smallest failing section → if a revision lowers quality, roll back to the last passing version.
