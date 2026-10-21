# SEI product maturity scoring

Use this contract only when the requester explicitly asks for the maturity of the Software Engineering Intelligence product. It does not grade the repository being inspected and does not emit repository health, candidate priority, architecture judgment, lifecycle state, remediation order, or completion authority.

The runner loads the package-pinned `sei-maturity-v1` rubric. Callers provide a closed evidence bundle, not weights or thresholds. Unsupported criteria receive zero. Evidence is capped by its attribution level: implementation, focused deterministic, synthetic integration, one real oracle, heterogeneous real oracles, or temporal holdout. Predictive claims require temporal holdout for full credit; provenance is the sole focused-evidence full-credit exception.

Promotion is separate from the numeric total. It requires the fixed category floors plus report/schema integrity, useful repeated incremental runs, honest framework `NOT SCORED`, heterogeneous repositories, merge-heavy and large-repository evidence, and leak-free predictive validation against all declared naive baselines. A blocked result is valid evidence, not a failure to generate a scorecard.

The command is:

```bash
node <installed-skill>/scripts/score-sei-maturity.js --evidence <bundle.json> --out <directory> [--require-promotion]
```

Outputs are content-addressed JSON and deterministic Markdown under the caller-selected directory. Existing different bytes at an output identity fail closed. The stdout receipt binds both paths and SHA-256 digests. The optional promotion flag changes only the process exit status when promotion is not `pass`.
