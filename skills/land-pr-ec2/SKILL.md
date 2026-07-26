---
name: land-pr-ec2
description: "Land a repository change through a pull request and release only its mapped service to a configured Amazon EC2 target. Use when the user asks to land work and deploy its affected service to EC2."
---

# Land a PR to EC2

Use **release** as the gate: every deployment action must prove its target, service, exact revision, and resulting health. Treat [land-pr](../land-pr/SKILL.md) as the source of truth for change scope, pull-request safety, merge policy, and main-only cleanup.

## Safety rules

- Release exactly one mapped service for each landing; inspect unaffected services without rebuilding or restarting them.
- Use an existing, repository-documented deployment entrypoint and an already configured EC2 target.
- Identify one target through a trusted SSH host alias or documented SSM target; a new or mismatched host identity blocks deployment.
- Wake only the documented instance, and never when the billing kill switch has tripped — a tripped kill switch is a spend incident to investigate, not a box to restart.
- Keep credentials in their existing secret store or SSH agent; redact command output and never print secret values.
- Deploy the recorded merged commit or an immutable artifact/image digest mapped to it, never a moving branch tip or tag.
- Require a clean selected source checkout on the target. Preserve any dirty or untracked target file and report it as a blocker rather than discarding it.
- Record the current release before mutation. A database-changing release needs its documented backup, migration, and recovery proof before activation.

## 1. Land to the deployment handoff

Run [land-pr](../land-pr/SKILL.md) through Section 10. Stop after its synchronization proof; this skill owns the one-service release before Sections 11–12 restore main-only state.

Record the PR number, default branch, merged commit SHA, primary worktree, and synchronized `origin/<default-branch>` SHA. Prove the merged commit remains reachable from that remote-tracking branch:

```bash
gh pr view "<pr-number>" --json state,mergedAt,mergeCommit --jq '.mergeCommit.oid'
git -C "<main-worktree>" merge-base --is-ancestor "<merged-commit-sha>" "origin/<default-branch>"
```

**Release proof:** GitHub reports the PR as merged, the primary worktree is synchronized, and the exact release commit is recorded.

## 2. Resolve the service release contract

Read repository instructions, deployment scripts, CI configuration, and target service configuration. Record one explicit contract containing:

- trusted target identifier and transport;
- source repository checkout on the target, exact mapped service, and activation entrypoint;
- current-release identifier, selected source revision, and any artifact/image digest;
- one target-internal probe and one independent external health or smoke probe;
- migration, backup, and recovery proof when the service changes persistent data;
- rollback entrypoint and previous-release identifier.

When the target uses Docker Compose, read [Compose EC2 release](references/compose-ec2-release.md) before changing the target. Resolve a source repository to exactly one Compose service from its build context. A deployment-repository change requires an explicit service mapping; do not widen it to the whole stack.

Treat an existing deployment script as usable only when it consumes the exact release identity, changes one mapped service, preserves the source checkout, and supplies probe and rollback evidence. Otherwise follow the corrected contract instead of executing the script unchanged.

**Release proof:** record every contract field and the one selected service.

## 3. Reconcile the live target

Run the contract’s read-only probes. Where AWS manages the target, verify that the instance is running, its system and instance checks pass, and its ingress matches the deployment contract. For SSH, require unattended authentication and known-host verification:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "<ec2-host-alias>" "<documented-read-only-probe>"
```

### Wake a stopped target

Where AWS manages the target and it reports `stopped`, treat that as recoverable, not a blocker: the documented auto-stop safety net (idle alarm after 2 h of <2% CPU, nightly 04:00 ET backstop — `infra/aws/auto-stop.md` in the infra repository) stops the box by design. Before starting it, prove the stop is the safety net and not a spend incident:

```powershell
# Kill switch must be armed, not tripped (STANDBY = armed; see infra/aws/kill-switch.md)
aws budgets describe-budget-actions-for-budget --account-id "<account-id>" --budget-name kill-switch `
  --query "Actions[].Status" --output text
```

Any status other than `STANDBY` blocks deployment and preserves the target stopped. Otherwise wake it and wait for both status checks before probing:

```powershell
aws ec2 start-instances --instance-ids "<instance-id>" --region "<region>"
aws ec2 wait instance-status-ok --instance-ids "<instance-id>" --region "<region>"   # ~1-3 min
```

The shared box holds an Elastic IP, so its address survives stop/start; if the target ever loses that property, re-resolve the SSH host alias before trusting it. After the wait, rerun the reachability probe above. The safety net remains armed — the box will stop itself again after the release once idle, which is the intended steady state.

**Release proof (when woken):** record the prior `stopped` state, the kill-switch `STANDBY` status, the start time, and the passing status checks alongside the reconciliation evidence below.

Record the active service state, current release, selected-source status, and current health. A reachability, identity, dirty-source, or unhealthy-service result — after any wake — blocks deployment and preserves the target unchanged.

**Release proof:** the mapped service is live, its current release is recorded, and the target is ready for a one-service change.

## 4. Stage the exact release

Fetch the target source checkout and prove `<merged-commit-sha>` is reachable from its default branch. Record the current source revision before selecting the merged commit. Build from that exact commit or from an immutable artifact/image digest tied to it; never let the target silently advance to the default branch.

For a source build, require locked dependencies or record that the release identity is source-locked rather than image-immutable.

**Release proof:** the selected build input resolves exactly to the merged commit and the previous release is recoverable.

## 5. Build and activate only the mapped service

Run the contract’s one-service build and activation command. Keep database, proxy, and unrelated application services running unless the mapped service contract explicitly includes them. Capture a redacted deployment log.

**Release proof:** only the mapped service changed, and the target reports it running on the recorded release.

## 6. Verify the live release

Run both recorded probes. Compare an exposed version, source SHA, artifact digest, or other release marker with the staged release whenever the service provides one.

**Release proof:** the internal and external probes pass, and the live service resolves to the recorded release identity.

## 7. Recover and restore main-only state

When staging, activation, or verification fails, invoke the documented rollback to the recorded previous release and rerun both probes. A release with an irreversible migration uses its documented recovery plan; otherwise report the live incident and perform no further server mutation.

After the EC2 outcome is recorded—deployed, rolled back, or unresolved—run [land-pr](../land-pr/SKILL.md) Sections 11–12. GitHub has already proved the merge, so restore the required main-only repository state even when the release outcome is a failure; report that failure rather than claiming a successful deployment.

**Final proof:** report the PR URL, merged commit, target identifier, mapped service, staged and prior release identities, deployment or rollback outcome, both probe results, and the base skill’s final main-only proof.
