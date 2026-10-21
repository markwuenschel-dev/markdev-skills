# Architecture Note: Parent-Owned Evidence, Decision State, Grillsmith, and Conditional Graph Escalation

## Shared epistemic substrate

Before decision discovery, the parent owns one validated Evidence Recon v1 packet. Narrow evidence work stays inline; wide, heterogeneous, high-completeness evidence work may fan out into expedition lanes. Both modes produce the same epistemic contract: coverage, evidence quality, confirmed/inferred/unknown, negative-claim receipts, contradictions, limitations, and handoff references.

This packet is deliberately orthogonal to the decision model. Evidence completeness does not imply decision completeness, and an Evidence Recon `possible_decision_surface` is only a seed for the mandatory coverage sweep.

Specialist lanes see only slices of the decision surface. Letting each lane run its own interview or produce an authoritative design creates duplicate questions, contradictory terminology, local optimization, hidden dependency errors, and unclear ownership.

The parent therefore owns one canonical decision state and one candidate-question pool. The decision state is **flat by structure when the decisions are independent** and becomes a **dependency graph only when real topology exists**.

The mandatory coverage sweep is separate from graph materialization. The sweep discovers consequential decisions; the topology pass decides how those decisions should be represented. Skipping the graph when there are no meaningful edges is legitimate. Skipping the sweep because the graph seems unnecessary is not.

The parent merges evidence and candidate decisions, runs coverage sweeps, overgenerates and deduplicates candidate questions, acts as the **Grillsmith** that sharpens and quality-gates them, selects flat or graph representation, packs the maximum coherent recommendation-led interview packet, interprets answers, derives requirements, updates canonical documents, re-evaluates topology after every answer bundle, runs closure checks, and decides when to stop.

When flat mode develops a prerequisite, conditional, invalidation, exclusion, unlock, fact-gating, or multi-round eligibility relationship, the parent promotes the state to graph mode while preserving stable IDs and all settled evidence and answers.

Child lanes are evidence collectors, question-discovery scouts, mechanism comparators, and adversarial critics. They may propose multiple formulations, candidate recommendations, and topology observations, but they never expose raw questions directly to the user. Only the parent presents the canonical interview, and only the human decision owner can confirm or approve decisions.

This separation is intentional: parallelism should increase coverage and question quality without producing multiple competing interviews, and topology machinery should appear only when it earns its keep.
