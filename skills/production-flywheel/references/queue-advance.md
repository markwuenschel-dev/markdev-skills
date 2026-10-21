## Stage 14 — Advance the queue

Print the per-item completion footer (Stage 2), then move to the next item **automatically**:

```text
Completed queue item 2/5:
- Branch:
- PR:
- Verification: PASS | FAIL | BLOCKED-UNVERIFIABLE | ESCALATE (exit code) · round n of 3
                 | n/a — Decision Terrain handoff, planning only, never reached Stage 11
- Evidence: <evidence_dir> · packet lock <sha> · tamper_evidence: hmac | chain-only
- Tests:
- Notes:
Moving to item 3/5.
```

Do not ask whether to continue. Auto-advance until:

- **the queue is empty** → print a final per-item summary (each item's branch/PR/status) and stop — if the run left multiple PRs open, note that `/land-pr 45, 47, 48` can land them as one confirmed batch — or
- **a real blocker appears** → pause the queue, state which item blocked and why, and ask how to proceed. A pushed PR awaiting review is not a blocker.

**Under `--graph`:** after each item ships or is recorded blocked, recompute the frontier from current node states — a completed item may unblock others via `depends_on`. Print the updated frontier as part of the completion footer. Continue automatically through pre-authorized items; stop to ask when the frontier holds eligible items the user has not pre-authorized, or when it is empty. **An empty frontier and an empty queue are different states** — the frontier can be empty while blocked items remain (unmet `depends_on`, open human decisions), which is not the same as every candidate reaching a terminal state; report the count and cause of anything still blocked rather than reporting the run complete.

**Under `--action-graph`:** after each action ships or is recorded blocked/failed, recompute the frontier from the CURRENT durable `execution_state` (never a cached one) — a completed action may unblock others via `hard_requires`. This is the biggest behavioral difference from candidate-graph mode's simpler "one candidate, one `depends_on` chain" model, and it must be said plainly: a candidate reaching `complete` is **derived** (see [ACTION-GRAPH-MODE.md](../ACTION-GRAPH-MODE.md) and `shared/action-graph-execution/EXECUTION-GRAPH-MODEL.md`) — every action covering it must be durably complete, its verification obligations current, and its terminal record must carry at least one `verification_refs` entry — never assumed just because one covering action finished. Print the updated frontier and, where relevant, updated candidate resolution as part of the completion footer.

When the queue completes, offer to regenerate the report (Stage 1) for a fresh batch if the user wants to keep going — but do not auto-start a new batch; a new batch requires a new selection. Reuse remaining candidates from the prior report only when the shipped slices touched none of the modules they name; otherwise regenerate.

Gate:
- Every selected item ended in a classified state (shipped PR, `pushed-pr-pending`, or an explicitly reported blocker).
- **Every shipped item has a `verdict.json` at a recorded path with exit `0`, `"verdict": "PASS"`, and a matching packet lock.** An item that shipped without one is a process failure — report it as such rather than letting it pass into the summary as complete.
- No PR was merged unless the user explicitly said merge.
- The queue stopped only because it was empty or blocked — never merely because a PR was opened.
- No item was advanced past Stage 11 while its verifier was still running.
