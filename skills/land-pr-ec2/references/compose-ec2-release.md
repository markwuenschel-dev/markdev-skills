# Compose EC2 release

Read this reference when the selected target is a Docker Compose deployment on EC2.

## Resolve one service

From the Compose root, list services and inspect the resolved Compose configuration. Map an application repository to the service whose scalar `build` path or `build.context` resolves to that repository's target checkout. Continue only when exactly one service matches.

For a change in the deployment repository itself, use an explicit repository-owned mapping from changed files to a service and activation command. A Compose-file, proxy, shared Dockerfile, migration, or secret-contract change has no safe generic default.

Record this contract before changing the target:

- Compose root and service name;
- source checkout and merged commit SHA;
- current source SHA and current image ID or digest;
- one internal endpoint and one external URL/path;
- database/migration and rollback policy.

## Reconcile before staging

Use the active shell to express these Git and Compose operations. First prove the selected source checkout is clean, the service is currently running, and dependencies required by `--no-deps` are healthy:

```bash
git -C "<source-checkout>" status --short
git -C "<source-checkout>" rev-parse HEAD
docker compose config --services
docker compose ps --all
```

An untracked or modified file in the selected source checkout blocks the release; preserve and report it. A dirty file in an unrelated checkout remains untouched and is reported only when it affects the selected service.

## Stage an exact source release

Record the prior source SHA, fetch the default branch, prove the merged commit is in it, then select that immutable commit without resetting or discarding files:

```bash
previous_sha="$(git -C "<source-checkout>" rev-parse HEAD)"
git -C "<source-checkout>" fetch origin "<default-branch>"
git -C "<source-checkout>" merge-base --is-ancestor "<merged-commit-sha>" "origin/<default-branch>"
git -C "<source-checkout>" switch --detach "<merged-commit-sha>"
```

Do not use `git pull`, `git reset --hard`, or a default-branch name as the build input. A Git commit locks the source revision; call the resulting release image-immutable only when its digest is recorded. If the build cannot be reproduced from locked inputs, require a prebuilt image digest instead.

## Build, activate, and prove

Build and activate only the mapped service. `--no-deps` preserves already-healthy dependencies and prevents an all-stack rollout:

```bash
docker compose build "<service>"
docker compose up -d --no-deps "<service>"
docker compose ps "<service>"
```

Run the recorded internal probe through the deployment network and the independent external probe through the public route. Capture both exit statuses and responses without logging credentials.

## Recover

When activation or either probe fails before an irreversible migration, return the source checkout to `previous_sha`, rebuild only the mapped service, reactivate it with `--no-deps`, and rerun both probes:

```bash
git -C "<source-checkout>" switch --detach "$previous_sha"
docker compose build "<service>"
docker compose up -d --no-deps "<service>"
```

When the release runs migrations or changes durable data, use the contract's backup and recovery process. Do not assume that rolling code back reverses the schema.
