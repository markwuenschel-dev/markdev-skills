# Architecture Note: Parent-Owned Synthesis

Specialist lanes are evidence collectors and question generators because independent lanes see only slices of the decision surface. Letting each lane produce authoritative designs creates duplicated questions, contradictory terminology, local optimization, and unclear ownership.

The parent maintains the shared uncertainty model, merges cross-lane questions, orders the interview, interprets answers, resolves conflicts, updates canonical documents, and decides when to stop. This preserves multi-perspective challenge without turning the user into the integration layer or allowing child agents to claim decision authority.
