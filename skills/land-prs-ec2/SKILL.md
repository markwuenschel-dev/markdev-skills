---
name: land-prs-ec2
description: "Lands multiple open pull requests as one confirmed queue, then releases each affected mapped service exactly once to its configured Amazon EC2 target at the final merged revision. Runs land-prs for discovery, queue confirmation, and the serial landing loop; applies land-pr-ec2's release contract per service: immutable release identity with a per-PR ancestry proof, one-service activation with internal and external probes, documented rollback, and serial service releases that halt on the first rollback. Use when several open PRs need landing and their services deployed — 'land all my PRs and deploy', or closing out a production-flywheel queue with a release. For a single change or single PR with deployment, use land-pr-ec2; for landing without deployment, use land-prs. Never merges or deploys without the user's request and a confirmed landing queue."
---

# Land PRs to EC2

Use **release** as the gate, exactly as `land-pr-ec2` does — every deployment action proves its target, service, exact revision, and resulting health. Treat [land-prs](../land-prs/SKILL.md) as the source of truth for queue discovery, confirmation, the serial landing loop, and main-only restoration; treat [land-pr-ec2](../land-pr-ec2/SKILL.md) and its [Compose EC2 release](../land-pr-ec2/references/compose-ec2-release.md) reference as the source of truth for per-service release mechanics. This skill owns only what neither parent defines: the **batch release model** that connects merged PRs to a set of one-service releases.

Intentionally omitted frontmatter: no `allowed-tools` grant. Production mutation is where permission prompts earn their friction; every state-changing command on a target should be individually visible.

## The batch release model

- **One release revision.** After the landing loop and default-branch synchronization, `release_sha` is the synchronized `origin/<default-branch>` tip. Every merged PR's merge commit must prove ancestry into it (`git merge-base --is-ancestor`). Targets deploy that immutable SHA (or an image digest tied to it) — never a branch name, never per-PR revisions. N merges produce one revision, not N deployments.
- **A deduped service set.** Map each **merged** PR to its one service via `land-pr-ec2` §2 (Compose: build context resolution). Two merged PRs mapping to the same service release it once. Blocked, left-open, and queued PRs contribute nothing to the set — and when a blocked PR shares a service with a merged one, the service still releases at `release_sha`, which **excludes the blocked PR's changes by construction**; the report must say so explicitly.
- **Serial releases, halt on first rollback.** Services release one at a time, each with its own probes and recorded previous release. A failed release rolls back that service and **halts the remaining releases** — a target that just demonstrated instability is not a license for further mutation. Remaining services record `not-released-halted`. This deliberately diverges from the landing loop's continue-past-blockers rule: merge blockers are independent; deployment failures may be systemic.
- **One target per service, proven.** Each service's contract names its own trusted, already-configured target (SSH alias or documented SSM target). Multiple targets are allowed only this way; identity, credential, and redaction rules apply per target. A stopped AWS-managed target is recoverable through `land-pr-ec2` §3's wake procedure — kill-switch `STANDBY` proof before any start; a tripped kill switch is a spend incident that blocks every service on that target. *(Mirror of `land-pr-ec2` Safety rules — keep in lockstep.)*

## 1. Land the queue to the release handoff

Run `land-prs` Sections 1–3: discovery and exclusions, the printed landing queue with its **human confirmation gate** (an invocation that enumerated PRs is that confirmation; "deploy" in the request authorizes the release phase for the merged results), the serial landing loop, and default-branch synchronization. **Stop before `land-prs` §4** — restoration waits until the release outcome is recorded, exactly as `land-pr-ec2` holds `land-pr` §11–§12.

Record every terminal state, then:

```bash
release_sha="$(git -C "<main-worktree>" rev-parse "origin/<default-branch>")"
git -C "<main-worktree>" merge-base --is-ancestor "<merge-commit-sha>" "origin/<default-branch>"   # once per merged PR
```

Zero merged PRs → skip to Section 6; there is nothing to release.

**Release proof:** `release_sha` recorded; every merged PR's ancestry proof succeeded.

## 2. Resolve the batch release contract

For each merged PR, resolve its one mapped service per `land-pr-ec2` §2 — repository instructions, deployment scripts, CI and target configuration; Compose targets follow the Compose reference's build-context rule. A deployment-repository change requires an explicit repository-owned file-to-service mapping; with none, that PR's release is blocked as `not-released-missing-mapping` — never widened to the whole stack.

Dedupe into the **service set**. For each service, record the full `land-pr-ec2` §2 contract: trusted target and transport; source checkout, service, and activation entrypoint; current-release identifier; `release_sha` (and image digest when image-immutable); one internal probe and one independent external probe; migration/backup/recovery proof when persistent data changes — a batch note: migrations from several merged PRs activate together, so the backup precedes the service release as a whole; rollback entrypoint and previous-release identifier.

Order the set by documented dependency order, else stable name order, and print the **release queue**: service, target, current release → `release_sha`.

**Release proof:** every contract field recorded per service; the release queue printed.

## 3. Reconcile every live target before any mutation

Run the read-only reconciliation of `land-pr-ec2` §3 for **every** service in the set — instance state where AWS manages it; `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes` reachability; active service state, current release, clean selected source checkout, current health — **before the first mutation anywhere**. Read-only checks are cheap; discovering a dead or dirty target after a sibling service already mutated is not.

A target reporting `stopped` under AWS management follows `land-pr-ec2` §3's wake procedure during this pass: prove the kill switch is `STANDBY` before `start-instances`, record the wake evidence per its "Release proof (when woken)", and wake each distinct target **at most once** — a batch is one wake, not one per service. Any kill-switch status other than `STANDBY` is a spend incident: every service on that target records `not-released-blocked` and the target stays stopped. If the documented auto-stop backstop stops a target again mid-batch (long runs can cross it), repeat the wake proof before the next activation on that target rather than assuming reachability.

A reachability, identity, dirty-source, or unhealthy result — after any wake — marks that service `not-released-blocked` with the exact output and preserves its target unchanged; the rest of the set proceeds.

**Release proof:** every service in the set is marked ready or blocked, with output; any wake carries its recorded kill-switch status, start time, and passing status checks.

## 4. Stage once per target, release serially

Stage each ready target's source checkout per the Compose reference: record `previous_sha`, fetch, prove `release_sha` ancestry, `switch --detach "<release_sha>"` — no `pull`, no `reset --hard`, dirty files preserved as blockers.

Then release the ready services **in queue order, one at a time**: the contract's one-service build and activation (`--no-deps` for Compose), unrelated services untouched, deployment log captured and redacted. After activation, run both probes and compare any exposed release marker to `release_sha`.

- Probes pass → `released`, next service.
- Failure → documented rollback to that service's previous release, rerun both probes, record `rolled-back` (or the incident, per `land-pr-ec2` §7, when a migration is irreversible — no further mutation to that target), **halt**: every remaining service records `not-released-halted`.

**Release proof:** each attempted service ends `released` or `rolled-back` with both probe results; nothing beyond a halt was mutated.

## 5. Verify the batch outcome

One line per service in the set: target, prior release → attempted release, probe results, terminal release state — `released`, `rolled-back`, `not-released-blocked`, `not-released-halted`, or `not-released-missing-mapping`. Every service accounted for, none silently absent.

## 6. Restore main-only state and report

GitHub already proved the merges, so run `land-prs` §4 restoration **regardless of release outcome** — a failed release is reported, never hidden behind a skipped cleanup and never described as success. Then produce `land-prs` §5's landing report extended with the release columns from Section 5, the explicit note for any blocked PR whose service released without its changes, and a short list of exactly what needs the user: conflicts, reviews, halted services, unresolved incidents.

**Final proof:** every queue entry has a landing terminal state, every service in the set has a release terminal state, restoration ran (or its blockers are named), and the report claims nothing beyond the recorded proofs.
