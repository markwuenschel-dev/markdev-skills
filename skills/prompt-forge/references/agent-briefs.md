# Brief Mode — Long-Horizon and Multi-Agent Launch Prompts

For agents expected to work autonomously for hours or days, alone or as an orchestrator managing parallel workers. The controlling trade-off: everything that makes a long run productive — persistence, autonomy, parallelism — raises the cost of a weak specification. A short interactive prompt fails cheaply; a long-horizon brief with a loophole burns hours producing an answer-shaped artifact that does not solve the problem.

The central technique is the **pseudo-formal task brief**: a specification written with the rigor of formal verification but expressed linguistically, because most hard problems have no machine-checkable success condition. Copy `assets/brief-template.md` and fill it using this file.

## Brief anatomy

| Block | Job | Failure it prevents |
|-------|-----|---------------------|
| Definitions | Fix every load-bearing term, including degenerate cases | Loophole solutions on technicalities |
| Success predicate | One statement of what must be true of the returned artifact, quantifiers and scope spelled out | Scope-narrowed answers |
| Non-counting outcomes | Enumerated near misses that do not count | Answer-shaped partial results |
| Solvability framing | "Assume a solution exists" where existence is plausible | Give-up drift, "this is open" refusals |
| Orchestration policy | Heuristics for allocating parallel workers, never fixed assignments | Premature convergence, wasted parallelism |
| Verification policy | Adversarial audit against an enumerated failure-mode list | Lenient self-judging |
| Reporting contract | Concrete artifacts required; status reports rejected | Vague optimism, fabricated progress |
| Return condition | Return only when the artifact survives audit | Premature return, best-effort summaries |
| Effort floor | Minimum effort before giving up may be considered | Early abandonment |
| Contamination guards | What external search may and may not be used for | Laundered lookups, leakage |

Highest-leverage block: **non-counting outcomes**. Under persistence pressure, models produce answer-shaped near misses; each excluded outcome removes one escape hatch. Write it by predicting what a capable agent under pressure would return instead of a solution: the narrowed-scope version, the reduction to an unvalidated assumption, the bounded verification, the survey, the plan, the confident sketch.

## Writing workflow

1. **Success predicate first**, one sentence, explicit quantifiers and scope. If it cannot be written precisely, the problem is not ready for a long-horizon run — decompose it or run a scoping session instead, and tell the user so.
2. **Enumerate non-counting outcomes** by predicting near misses (above).
3. **Define terms**, starting from the degenerate cases the predicate must survive (the empty input, the trivial solution, the duplicate, the zero-measurement; in empirical domains: units, populations, inclusion criteria, measurement procedure).
4. **Write the auditor checklist**: the domain-specific ways a candidate can look right and be wrong — known confounders, leakage paths, too-good-to-be-true signatures, and always the domain's version of circularity: satisfying the goal by assuming something equivalent in strength to it. Auditors with an enumerated hunt list catch what "check the work" misses.
5. **Set orchestration policy as heuristics** (parallel runs only): genuinely diverse opening portfolio; early workers blind to the favored approach; an explicit registry of approach families grouped by underlying idea, not surface wording; redirect away from crowded families; mark a route blocked when it stalls at a gap as hard as the original goal, reopen only for a materially new mechanism; cross-pollinate late, after independent development. Never fixed worker-to-strategy quotas. Inter-agent agreement is a diversity-failure signal, not corroboration — committees converge tightest on the hardest problems.
6. **Set the reporting contract and return condition**: workers return concrete artifacts (lemmas, constructions, scripts, datasets, measurements) appropriate to the domain; status reports and "this step is routine" claims are rejected; every progress claim must trace to a tool result or artifact from the current session. The return condition is a predicate over the artifact — never over the agent's confidence, effort, or elapsed time. Structure the final artifact modularly so each part verifies in isolation with premises and conclusion stated locally.
7. **Add effort floor, solvability framing, contamination guards.** An effort floor removes permission to quit early; it neither schedules nor bounds runtime — enforce real time/cost budgets in the harness, not the prompt. Contamination guard: external search for background material only, never for the answer the result must be independent of.
8. **Red-team before launch**: ask a fresh model instance "how could an agent satisfy the letter of this brief without solving the problem?" and patch every credible answer.

## Delegation spec for spawned workers

Every subagent spawn in an orchestrator brief carries all four, or coverage overlaps and gaps: **objective · output format · tool guidance · task boundaries.**

## Verification bottleneck

Parallel sampling raises the chance some worker finds a correct answer; selection lags behind, and model judges of hard artifacts are systematically lenient toward rigorous-looking but incomplete work. Budget as much brief design for the verifier as the generator:

- Auditors get the enumerated failure-mode list from the brief, not a generic quality instruction.
- Generators produce modular, independently checkable output so verification decomposes.
- Use fresh-context adversarial verifiers, not self-critique — a verifier that built the artifact rationalizes its gaps.

## Prompt vs. harness

The brief can only request; the harness enforces. Hard budgets, locked evaluators, rollback, tool permissions, and approval boundaries that must survive optimization pressure belong in runtime control surfaces, not prompt text — prompt-stated constraints are advisory. A budget or reminder stated once at the top decays as the trajectory grows; verified-progress state and remaining budget should be re-injected periodically from outside the loop (an externally maintained ledger), which the brief's reporting contract should anticipate.

## Gotchas

1. **Circular satisfaction** — the subtlest near miss is an argument assuming a statement equivalent in strength to the goal. Name the domain's version on the auditor checklist explicitly or it will not be caught.
2. **Persistence without verification breeds hacking** — if the brief demands "do not return without success" but success is checked leniently, the agent optimizes the leniency. Standing rule 5 exists for this.
3. **Assume-solvable on ill-posed problems** — solvability framing instructs the model never to conclude "no solution exists." On genuinely open questions, pair it with an explicit counterexample/impossibility track ("a complete demonstration of impossibility also counts; nothing in between does") or drop it, or the run fabricates.
4. **Status-report theater** — long runs drift into reporting activity instead of results. Artifact-based reporting plus evidence-traceable claims is the fix; "on track" without a pointer is rejected.
5. **Over-prescription** — step-by-step scripts and stacked emphasis degrade current frontier models. Migrate legacy prompt stacks by rebuilding from the minimal brief, not by accretion. Spend the token budget on what training cannot supply: the success predicate, the non-counting list, and the domain failure modes only an expert knows.

## Pre-launch rubric

Score the finished brief; any "no" is a defect to fix before committing agent time:

- Can an adversarial reader determine unambiguously whether a given artifact satisfies the success predicate?
- Is every plausible near miss explicitly non-counting?
- Does the auditor have an enumerated, domain-specific failure-mode list?
- Is every persistence instruction paired with a verification gate?
- Is the return condition a predicate over the artifact?
- Does orchestration preserve early independence and include blocked-route bookkeeping?
- Are reporting requirements artifact-based with evidence-traceable claims?
- Are contamination guards stated for any external retrieval?
- Is anything here a constraint that must survive optimization pressure? Move it to the harness.

## Worked contrast

Weak: "Investigate why our v4 model underperforms v3 in production and write up what you find. Be thorough."

Strong: TASK: identify a defect that, when corrected, closes the v4-vs-v3 gap on the frozen evaluation slice, demonstrated by a reproduction script and a corrected run. DOES NOT COUNT: correlational narratives without an intervention; defects explaining less than a stated fraction of the gap; "data drift" without an identified slice and mechanism; a list of hypotheses. VERIFICATION: an adversarial reviewer checks the reproduction for train/serve skew, eval-slice leakage, seed sensitivity, preprocessing divergence. RETURN: only a candidate that survives that review.

The weak version invites a status report. The strong version makes the deliverable checkable and pre-blocks the three likeliest near misses.
