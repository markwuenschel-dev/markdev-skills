# Adaptive Grilling

Use this procedure to turn lane packets into small interview rounds.

## Question value

Rank approximately by:

`decision impact × uncertainty × cost of being wrong × downstream choices affected ÷ answer burden`

Prefer questions that distinguish mechanisms, resolve several unknowns, expose assumptions, define invalid states, clarify authority, prevent rework, or establish proof and failure signals.

## Synthesis

Merge questions that address the same underlying decision. For example, product completion, API completion, persisted completion, and verification evidence should become one layered completion-semantics question. Preserve links from the synthesized question to every dependent lane and uncertainty.

## Adaptation

After each answer:

1. classify it as evidence, decision, requirement, assumption, accepted risk, or deferral;
2. update the documents and uncertainty states;
3. remove questions whose branches are now impossible;
4. launch only newly relevant follow-up lanes;
5. challenge contradictions between the answer and repository evidence;
6. select the next smallest useful round.

Stop when remaining uncertainty is owned or safely deferrable and another answer would not materially improve design quality.
