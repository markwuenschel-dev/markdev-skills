# Session handoff

> **Currency:** the newest valid file in this handoffs directory is the live checkpoint and supersedes every older one; the rest are kept only as history. Age alone never makes a handoff stale, and neither does the number of files beside it — only re-verified repository state can contradict this one. Keep this line verbatim.

```yaml
written: <UTC ISO-8601>
cwd: <absolute path>
root: <project root>
branch: <branch or n/a>
head: <short SHA or n/a>
focus: <focus hint or none>
dirty: <true|false>
```

## Goal and definition of done
<What the task is. Done means: observable criteria — commands that pass, behavior that exists.>

## Current state
**Done and verified**
- <item — verified by <command/read>>

**Done, unverified**
- <item — needs <check>>

**In flight**
- <item — exactly where it stands>

## Next action
<One concrete, file-and-line-anchored step.>

Then:
1. <follow-on step>
2. <follow-on step>

## Locked decisions and constraints
- LOCKED: <decision> — <one-line rationale>
- revisit-if <condition>: <decision> — <rationale>

## File map
- `<path>` — <purpose, touched/reference>

## Verification
- `<command>` → expected: <result>
- Env: <VAR_NAME in <location>; value not recorded>

## Dead ends
- <approach> — <why closed> (<evidence pointer>)

## Resume protocol
1. Read touched files in the file map.
2. Run the verification commands above; compare to expected.
3. Start the next action.
<session-specific requirements, e.g. dev server, fixtures>

## Redaction note
No secret values recorded. Credentials referenced by name and location only: <list or "none referenced">.
