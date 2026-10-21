---
name: wizard-mwdev
description: Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself.
---

# Wizard

A **wizard** is a bash script that walks a human, step by step, through a manual procedure that's tedious to do by hand and tedious to re-explain to an AI every time. It opens each URL, says exactly what to click and copy, captures the values, writes them where they belong (`.env`, GitHub secrets), confirms at every stage, and shows how many stages are left. It might configure third-party services, run a one-off migration, or move the project from one state to another.

The delightful UX is already solved by [template.sh](template.sh): stage-by-stage progress, confirmation gates, cross-platform URL opening (including WSL), hidden secret entry, idempotent `.env` upserts behind a git-ignore guard, `gh secret`/`gh variable` writes, and a closing summary. **Your job is only to scope the procedure and author its stages.** The library above the `STAGES` marker is identical in every wizard; that consistency is the point: never hand-edit it.

A wizard is ephemeral by default: built for one run, saved to a scratch or `scripts/` path, deleted when the job's done. Commit it only when the user wants a repeatable setup path that should live in the repo.

On native Windows the wizard runs under Git Bash or WSL (`open_url` uses `explorer.exe` / `wslview`); `chmod +x` and the `.env` file mode are no-ops there, so tell the user to run it as `bash <script>`.

## Process

### 1. Scope the procedure

Work out every manual step the human must take and every value that gets captured along the way. Read the repo first, don't ask cold:

- For setup: `.env`, `.env.example`, `.env.*`, `README`, `docker-compose*`, framework config, and `.github/workflows/*` (every `secrets.*` / `vars.*` reference is a value the wizard must produce).
- For a migration or transition: the current state, the target state, and the irreversible actions between them.

Then show the user the ordered list of stages and the values each produces, and confirm: they may add, drop, or reorder.

**Done when:** every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written (`.env`, a GitHub secret, both, or nowhere; some stages are pure actions), and (c) whether it's secret (hidden entry) or public.

### 2. Map each stage's journey

For each stage, write the precise path a human follows: which URL to open, what to do there, where a value is shown, which variable it fills: e.g. "Dashboard → Developers → API keys → Reveal test key → copy". Where you don't actually know the current UI or the exact command, say so and ask the user or check the docs: never invent steps that may not exist.

**Done when:** every stage traces to concrete instructions a stranger could follow.

### 3. Author the wizard

Copy `template.sh` to the target path. Replace the example stage with one `stage` per step, in dependency order. Use the library helpers: `stage`, `say`/`step`, `open_url`, `ask`/`ask_secret`, `require_match` (re-asks until a value fits a pattern, e.g. `^pk_test_`), `require_command` (stop early when a CLI the stages need is missing), `write_env`, `set_secret`/`set_var`, `pause`/`confirm`. `set_secret` and `set_var` write to `GITHUB_REPO=owner/name` when set, otherwise the checkout's repo, and the human confirms the target once before the first write. `set_var` passes its value as an argument, so never use it for a secret. Set `TOTAL_STAGES` to the number of stages you wrote.

Hold the bar the template sets: open the URL before asking for its value, use `ask_secret` for anything secret, `write_env` every persisted value, `set_secret` only the values CI actually needs, and `confirm` before any irreversible action. Each `stage` clears the screen so only the current step is visible: keep a stage to one focused task so nothing the human needs scrolls away. Don't touch the library above the marker.

### 4. Verify and hand off

- `node "${CLAUDE_SKILL_DIR}/scripts/check-wizard.js" <script> --repo <repo-root>`: runs `bash -n`, confirms the library above the marker is byte-identical to `template.sh`, that `TOTAL_STAGES` matches the `stage` calls, and that the example Stripe stage is gone. `--repo` compares every `set_secret` name with the `secrets.*` references in `.github/workflows`: a secret CI never reads fails the check (usually a typo), and a CI secret the wizard never sets prints a warning to resolve with the user.
- `shellcheck <script>`. If `shellcheck` is missing, do not install anything: report shellcheck as NOT RUN and tell the user that `pip install shellcheck-py` provides it. The library is shellcheck-clean, so any finding is in your stages.
- `chmod +x <script>`. The wizard exits 2 unless stdin is an interactive terminal; stdout may be piped (`bash <script> | tee setup.log`). `finish` exits 1 and says "Setup incomplete" when anything was skipped or the stage count is wrong.
- Don't run it end-to-end yourself: it opens browsers and blocks on human input. Trace it statically instead: every value from step 1 is captured and lands where step 1 said.
- Check that `ENV_FILE` is git-ignored (`git check-ignore -q .env`); the library stops before writing to a trackable file unless the human confirms. When the repo has `.env.example`, add each new key there with an empty value.
- Tell the user how to run it. If it's a repeatable setup path, link it from the README and ship it through `land-pr` (or `production-flywheel` when it is part of authorized work), so the next person runs the script instead of asking an AI.
