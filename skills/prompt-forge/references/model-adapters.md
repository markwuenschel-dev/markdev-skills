# Model Family Adapters

Adapt to family-level behavior, not version folklore. Model names, current defaults, context limits, and parameter flags are volatile: when the user names a specific version and its behavior materially changes the prompt, verify against current vendor guidance via web search instead of assuming. What follows is the durable layer.

## First split: reasoning-native vs. instruct

**Reasoning-native** (o-series, DeepSeek-R1, Qwen thinking mode, Gemini thinking, Claude extended thinking — any model that reasons across internal tokens before answering):

- Short, clean instructions: the goal, hard constraints, and what done looks like. Nothing more.
- Never add "think step by step", CoT scaffolding, or simulated deliberation — it actively degrades output. If the model exposes reasoning tags the user doesn't want, add "Output only the final answer, no reasoning."
- Zero-shot first; few-shot only if strictly needed and tightly aligned.
- Keep system prompts brief; long instruction stacks hurt reasoning models most.
- To influence depth where supported, use light steering ("think carefully before responding" / "prioritize responding quickly"), not fixed thinking budgets.

**Instruct / non-reasoning**: more explicit everything — spell out the logic, data, schema; precise format instructions and tightly matched examples pay off; good default when deterministic formatting matters more than open-ended planning.

If the mode is switchable (e.g., a thinking toggle), write for the mode the user will run, and say which mode the prompt assumes.

## Family notes (durable tendencies)

**Claude** — Follows instructions literally: missing context yields narrow literal output, not a smart guess, so front-load intent, scope, constraints, and acceptance criteria in the first turn of complex work. Explaining *why* a constraint exists improves generalization. XML-style tags help for multi-section prompts (`<context>`, `<task>`, `<constraints>`, `<output_format>`). Long documents before the question; the ask near the end; asking for relevant quotes first improves grounded analysis. Agentic Claude tends to over-engineer — add "Only make changes directly requested; do not add features, files, or abstractions beyond what was asked." 3–5 strong examples when examples are needed.

**OpenAI GPT (non-reasoning)** — Start with the smallest prompt that achieves the goal; add structure only when needed. Be explicit about the output contract and completion condition. Handles dense, compact instruction well. Constrain verbosity directly when needed ("Under 150 words. No preamble. No caveats."). State tool-use expectations explicitly when tools exist.

**Gemini** — Clear specific instructions; few-shot examples recommended by default, structurally consistent, positive demonstrations over anti-pattern-only. Prone to format drift — use explicit format locks with a labeled example. Prone to fabricated citations — add "Cite only sources you are certain of; if uncertain, say [uncertain]." For grounded tasks: "Base your response only on the provided context. Do not extrapolate." Long-context workflows benefit from many-shot when a large example bank exists; break very complex tasks into chained prompts rather than one hard-to-steer block.

**Open-weight / local (Llama, Mistral, Qwen instruct, etc.)** — Shorter, flatter prompts; deep nesting loses coherence. Be more explicit than with frontier hosted models. Always include a role in the system prompt — it is the highest-leverage lever and belongs in the deliverable so the user can set it in their model config. Ask which model is running before writing; families differ materially. Note sensible sampling defaults only when the user controls them (low temperature for deterministic/code tasks, higher for creative).

**OpenAI-compatible hosted models (various vendors)** — Prompts written for GPT transfer as a starting point; verify the specific vendor's constraints (sampling ranges, reasoning-tag behavior, context limits) before relying on them.

## Agentic harnesses (IDE and CLI coding agents, autonomous engineers)

The underlying model's family notes apply, plus harness rules:

- Structure: starting state + target state + allowed actions + forbidden actions + stop conditions + checkpoints. Stop conditions are mandatory (standing rule 8) — runaway loops are the dominant cost failure.
- Scope every instruction to paths: file/function anchors and a do-not-touch list; never a global instruction without an anchor.
- "Done when:" defines when the agent stops editing.
- Human-review triggers: "Stop and ask before deleting any file, adding any dependency, or touching schema/CI/infrastructure."
- Fully autonomous engineers (Devin-class) need the forbidden-actions list most — they decide unprompted without it. Fence the filesystem explicitly.
- Progress visibility when wanted: "After each step output ✅ [what was completed]."
- Explicitly direct context gathering and subagent use when needed ("Read all files in src/auth/ before starting"; "Use a subagent to investigate X so it stays out of main context") — current-generation agents are conservative with both by default.
- Full-stack app generators bloat by default: specify stack, versions, what NOT to scaffold, and "do not add auth, dark mode, or features not explicitly listed."
- Orchestrator/root prompts for multi-agent runs: switch to Brief mode (`references/agent-briefs.md`).

## Porting between families

1. Keep a provider-agnostic base: role, task, constraints, output contract, safety — the behavioral contract.
2. Adapt only the family-divergent layer: structure syntax (tags vs. headings), example count, verbosity/format locks, reasoning-scaffold presence, grounding guards.
3. Never transport reasoning-model assumptions, few-shot defaults, or formatting quirks blindly across families.
4. When behavior diverges sharply, specialize only the failing layer — do not fork the whole prompt.
5. Retest after any family or snapshot change; a port is a hypothesis until it passes the same cases.

Adapter notes in the deliverable: one or two lines per family stating what changed and why.
