# RIA evidence handoff

Read this reference only for an explicitly requested SEI evidence handoff into
a Repository Improvement Assessment baseline. SEI is a reusable evidence
source, not a fourth assessment owner.

## Ownership

RIA continues to reconcile exactly these assessment owners:

1. `repository-health-assessment` owns the canonical health grade and health evidence.
2. `codebase-integrity-audit-loop` owns integrity candidates.
3. `architecture-improvement-intelligence` owns architecture findings.

SEI may supply standalone provenance-bound snapshots and offline reports for
the owners to interpret under their own contracts. It does not become an
assessment packet, candidate ledger, action, grade, optimizer input, lifecycle
state, or verification verdict.

## Additive SEI assessment reference

The integrated RIA envelope may carry one optional, verified `sei_assessment_ref`
alongside its existing `engineering_intelligence_ref`.
RIA owns the reference validation, immutable storage, and dispatch envelope;
SEI remains the producer of the content-addressed assessment sidecar. The
sidecar is evidence for exactly three existing assessment owners, not a fourth
owner and not a replacement for `assessment_refs`.

RIA must verify the sidecar bytes, schema, evaluator identity, rubric and
standard digests, applicability digest, repository revision, snapshot identity,
and configuration binding before dispatch. A missing, stale, forged, or
wrong-owner reference fails closed. Consumers may use it read-only and must
echo the exact binding without copying the payload or changing their authority.

SEI does **not** define or emit `engineering_intelligence_ref`, `baseline_ref`,
or `assessment_refs`; those remain RIA/owner contracts.

An evidence run can be reused only under its own exact snapshot identity.
Never rewrite a snapshot to fit a parent baseline, and never infer a candidate
or health conclusion from a handoff request.
