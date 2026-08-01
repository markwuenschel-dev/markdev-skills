# EC2 release

Use this reference only for the `-ec2` overlay. Release an already-configured, mapped service at the immutable `release_sha` produced by the unified landing flow. Do not deploy a branch name, current target `HEAD`, or an unproven artifact.

## Resolve a release contract

Read repository deployment instructions, CI, and target service configuration. Before mutation, record for each service:

- trusted SSH alias or documented SSM target, source checkout, and exact service;
- current release identity, `release_sha`, and image digest if applicable;
- activation command, one internal probe, one independent external probe;
- migration/backup/recovery plan and rollback command with prior release identity.

For Compose, map an application repository to exactly one service by resolving `build` or `build.context`. A deployment-repository change needs an explicit file-to-service mapping. Shared Compose/proxy/Dockerfile/migration/secret changes have no generic mapping and block the release until the repository supplies one.

## Reconcile before mutating

Require known-host, unattended SSH; selected target source clean; active service/dependencies healthy; current release recorded; and both current probes understood:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "<ec2-host-alias>" "<documented-read-only-probe>"
git -C "<source-checkout>" status --short
git -C "<source-checkout>" rev-parse HEAD
docker compose config --services
docker compose ps --all
```

For an AWS-managed stopped instance, first prove the documented budget kill switch is armed (`STANDBY`), then start it and wait for passing instance status checks. Any other kill-switch state is a spend incident that blocks release; do not start the instance. A batch wakes one target at most once, and must repeat this proof if it stops again.

## Stage and activate one service

Record `previous_sha`, fetch the default branch, prove the merged `release_sha` is reachable, then select it without reset or pull:

```bash
previous_sha="$(git -C "<source-checkout>" rev-parse HEAD)"
git -C "<source-checkout>" fetch origin "<default-branch>"
git -C "<source-checkout>" merge-base --is-ancestor "<release-sha>" "origin/<default-branch>"
git -C "<source-checkout>" switch --detach "<release-sha>"
docker compose build "<service>"
docker compose up -d --no-deps "<service>"
docker compose ps "<service>"
```

`--no-deps` preserves healthy dependencies and prevents a whole-stack rollout. Capture redacted logs. Run the recorded internal and external probes and compare any exposed version/SHA/digest to `release_sha`.

## Recover

If activation or either probe fails before an irreversible migration, restore `previous_sha`, rebuild and reactivate only the mapped service with `--no-deps`, then rerun both probes:

```bash
git -C "<source-checkout>" switch --detach "$previous_sha"
docker compose build "<service>"
docker compose up -d --no-deps "<service>"
```

For migrations or durable-data changes, use the recorded backup and recovery plan; code rollback does not reverse schema changes. After a rollback or unresolved incident, halt remaining services and report the full evidence.
