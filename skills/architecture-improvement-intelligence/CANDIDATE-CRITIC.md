# Architecture Candidate Critic

Run before canonical scoring. The critic tests whether a proposal is genuinely architectural and whether the proposed transformation improves structural ownership rather than simply rearranging code.

## Required questions

For each candidate:

1. What conceptual burden exists now, and who currently pays it?
2. What exact structural transformation is proposed?
3. Where does the complexity go after the change?
4. Does the public/interface burden shrink, become more stable, or align better with ownership?
5. Does locality improve for the changes/bugs that motivated the candidate?
6. Does authority become clearer and singular where it should be?
7. What does the deletion test say about the current module/seam?
8. Is a proposed seam real? What substitution/adapter/ownership evidence supports it?
9. Could a materially cheaper local fix capture most of the benefit?
10. Could the proposal create a god module or over-centralized owner?
11. What concurrency, transaction, retry, failure, or recovery ownership changes?
12. What migration/compatibility burden appears?
13. What tests/proof obligations demonstrate the claimed improvement?
14. Which evidence is confirmed versus inferred/unknown?
15. What observation would falsify the recommendation?

## Hard-fail conditions

A candidate is ineligible for architecture scoring when any unresolved condition below applies:

- the problem is cosmetic/local code quality with no structural ownership/locality effect;
- the proposal only renames/moves files;
- complexity is displaced without clearer ownership or lower interface burden;
- a seam is introduced solely for hypothetical future flexibility;
- authority becomes dual/ambiguous;
- the recommendation relies on a broad negative claim without a valid coverage receipt;
- a materially cheaper local alternative provides nearly all benefit and no durable architecture reason rejects it;
- claimed benefits cannot be verified;
- known ADR/compatibility/migration consequences are omitted;
- the candidate merges unrelated lifecycles into one incoherent module.

## Outcomes

- `eligible` — proceed to canonical ledger scoring;
- `rewrite` — sharpen transformation/evidence and rerun critic;
- `downgrade_non_architecture` — route as local cleanup/implementation work;
- `needs_more_evidence` — return to Evidence Recon;
- `needs_human_decision` — route without pretending the architecture is settled;
- `reject` — preserve rejection reason to avoid rediscovery.
