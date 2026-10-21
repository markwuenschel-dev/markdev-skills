"use strict";
// Behaviour tests for template.sh helpers (sourced with WIZARD_LIBRARY_ONLY=1) and check-wizard.js.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, crossCheckSecrets } = require("./check-wizard.js");

const TEMPLATE = path.resolve(__dirname, "..", "template.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wiz-"));

function repo({ ignoreEnv = true } = {}) {
  const dir = tmp();
  spawnSync("git", ["init", "-q", dir]);
  if (ignoreEnv) fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  // gh stub: records argv and stdin, reports authenticated.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
case "$1 $2" in
  "auth status") exit 0;;
  "repo view") echo "me/fallback"; exit 0;;
esac
printf '%s\\n' "$*" >> "${dir}/gh.args"
cat >> "${dir}/gh.stdin"
`, { mode: 0o755 });
  return { dir, bin };
}

function run(r, script, input = "", env = {}) {
  const res = spawnSync("bash", ["-c", `set -euo pipefail; WIZARD_LIBRARY_ONLY=1 source "${TEMPLATE}"; ${script}`], {
    cwd: r.dir, input, encoding: "utf8",
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, ...env },
  });
  return { code: res.status, out: res.stdout + res.stderr };
}
const envFile = (r) => path.join(r.dir, ".env");

// 1. env file: write, upsert, quoting round-trip, mode 600
{ const r = repo();
  const res = run(r, `write_env A "it's ok"; write_env A second; write_env B 'x"y'; _existing B`);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /x"y$/);
  const body = fs.readFileSync(envFile(r), "utf8");
  assert.strictEqual(body.match(/^A=/gm).length, 1, "upsert keeps one A");
  assert.match(body, /^A='second'$/m);
  // NTFS has no POSIX mode bits; the 0600 contract is asserted wherever it can hold.
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(envFile(r)).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(r.dir).some((f) => f.startsWith(".wizard-env.")), "temp file cleaned up"); }

// 2. un-ignored .env: declined stops before writing; accepted writes
{ const r = repo({ ignoreEnv: false });
  let res = run(r, `write_env A 1`, "n\n");
  assert.strictEqual(res.code, 1, res.out); assert.ok(!fs.existsSync(envFile(r)));
  res = run(r, `write_env A 1`, "y\n");
  assert.strictEqual(res.code, 0, res.out); assert.ok(fs.existsSync(envFile(r))); }

// 3. tracked .env is refused
{ const r = repo({ ignoreEnv: false });
  fs.writeFileSync(envFile(r), "");
  spawnSync("git", ["-C", r.dir, "add", ".env"]);
  const res = run(r, `write_env A 1`, "y\n");
  assert.strictEqual(res.code, 1); assert.match(res.out, /tracked by git/); }

// 4. invalid names and multi-line values
{ const r = repo();
  assert.strictEqual(run(r, `write_env BAD-KEY 1`).code, 1);
  assert.strictEqual(run(r, `ask "A B" "x"`, "v\n").code, 1);
  const res = run(r, `write_env A $'line1\\nline2'`);
  assert.strictEqual(res.code, 1); assert.match(res.out, /multi-line/);
  assert.ok(!fs.existsSync(envFile(r)) || !/line2/.test(fs.readFileSync(envFile(r), "utf8"))); }

// 5. pause and confirm fail closed on EOF
{ const r = repo();
  assert.strictEqual(run(r, `pause`, "").code, 1);
  assert.strictEqual(run(r, `confirm "go?" && echo YES || echo NO`, "").out.includes("NO"), true); }

// 6. GitHub writes: confirmed repo, --repo flag, secret via stdin not argv
{ const r = repo();
  const res = run(r, `set_secret API_TOKEN s3cr3t; set_var REGION us-east-1; printf '%s\\n' "\${SKIPPED[@]:-none}"`, "y\n", { GITHUB_REPO: "me/app" });
  assert.strictEqual(res.code, 0, res.out);
  const args = fs.readFileSync(path.join(r.dir, "gh.args"), "utf8");
  assert.match(args, /^secret set API_TOKEN --repo me\/app$/m);
  assert.match(args, /^variable set REGION --body us-east-1 --repo me\/app$/m);
  assert.ok(!/s3cr3t/.test(args), "secret never in argv");
  assert.match(fs.readFileSync(path.join(r.dir, "gh.stdin"), "utf8"), /s3cr3t/);
  assert.match(res.out, /none$/m); }

// 7. declined repo confirmation is recorded as skipped, not success
{ const r = repo();
  const res = run(r, `set_secret API_TOKEN s3cr3t; printf 'SKIP:%s\\n' "\${SKIPPED[@]}"`, "n\n", { GITHUB_REPO: "me/app" });
  assert.match(res.out, /SKIP:GitHub secret API_TOKEN/);
  assert.ok(!fs.existsSync(path.join(r.dir, "gh.args"))); }

// 8. finish: honest about skips and wrong stage count
{ const r = repo();
  let res = run(r, `TOTAL_STAGES=1; stage one; finish`);
  assert.strictEqual(res.code, 0, res.out); assert.match(res.out, /Setup complete/);
  res = run(r, `TOTAL_STAGES=2; stage one; finish`);
  assert.strictEqual(res.code, 1); assert.match(res.out, /Setup incomplete/); assert.match(res.out, /ran 1 of 2/);
  res = run(r, `TOTAL_STAGES=1; stage one; SKIPPED+=("x"); finish`);
  assert.strictEqual(res.code, 1); }

// 9. require_match re-asks until the format fits
{ const r = repo();
  const res = run(r, `ask PK "pk:"; require_match PK '^pk_test_' "starts pk_test_"; echo "GOT:$PK"`, "nope\npk_test_123\n");
  assert.strictEqual(res.code, 0, res.out); assert.match(res.out, /GOT:pk_test_123/); }

// 10. running the script needs an interactive stdin; piped stdout is allowed
{ const r = repo();
  const res = spawnSync("bash", [TEMPLATE], { cwd: r.dir, input: "", encoding: "utf8" });
  assert.strictEqual(res.status, 2); assert.match(res.stderr, /interactive terminal/); }

// 11. check-wizard.js
{ const d = tmp();
  const t = fs.readFileSync(TEMPLATE, "utf8");
  const good = t.replace(/TOTAL_STAGES=1\n\nbanner "Stripe setup"[\s\S]*?\nfinish\n/, 'TOTAL_STAGES=2\n\nbanner "Demo"\nstage "One"\nsay "a"\nstage "Two"\nsay "b"\nfinish\n');
  assert.notStrictEqual(good, t, "fixture substitution applied");
  const f = path.join(d, "w.sh");
  fs.writeFileSync(f, good); assert.deepStrictEqual(check(f, TEMPLATE), []);
  fs.writeFileSync(f, good.replace("TOTAL_STAGES=2", "TOTAL_STAGES=3")); assert.ok(check(f, TEMPLATE).some((e) => /but 2 stage calls/.test(e)));
  fs.writeFileSync(f, good.replace("set -euo pipefail", "set -eu")); assert.ok(check(f, TEMPLATE).some((e) => /library above/.test(e)));
  fs.writeFileSync(f, good.replace('say "b"', 'say "b'));  assert.ok(check(f, TEMPLATE).some((e) => /bash -n failed/.test(e)));
  fs.writeFileSync(f, t.replace(/^/, "")); assert.ok(check(f, TEMPLATE).some((e) => /Stripe/.test(e)), "example stage flagged in a copy");
  fs.writeFileSync(f, good.replace('say "a"', 'open_url "https://dashboard.stripe.com/test/apikeys"'));
  assert.deepStrictEqual(check(f, TEMPLATE), [], "a real Stripe stage is not mistaken for the example"); }


// 12. CI secret cross-check
{ const d = tmp();
  fs.mkdirSync(path.join(d, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(d, ".github", "workflows", "ci.yml"),
    "env:\n  KEY: ${{ secrets.STRIPE_SECRET_KEY }}\n  TOK: ${{ secrets.GITHUB_TOKEN }}\n  B: ${{ secrets['SENTRY_DSN'] }}\n");
  const w = path.join(d, "w.sh");
  const t = fs.readFileSync(TEMPLATE, "utf8");
  fs.writeFileSync(w, t);
  let x = crossCheckSecrets(w, d);
  assert.deepStrictEqual(x.errors, []);
  assert.deepStrictEqual(x.warnings, ["CI reads secrets.SENTRY_DSN but the wizard never sets it"], "GITHUB_TOKEN ignored, bracket syntax read");
  fs.writeFileSync(w, t.replace("set_secret STRIPE_SECRET_KEY", "set_secret STRIPE_SECRET_KY"));
  x = crossCheckSecrets(w, d);
  assert.deepStrictEqual(x.errors, ["set_secret STRIPE_SECRET_KY is never read by CI (.github/workflows has no secrets.STRIPE_SECRET_KY)"]);
  assert.ok(x.warnings.some((m) => /STRIPE_SECRET_KEY/.test(m)), "a typo shows on both sides");
  const cli = spawnSync("node", [path.join(__dirname, "check-wizard.js"), w, "--repo", d], { encoding: "utf8" });
  assert.strictEqual(cli.status, 1); assert.match(cli.stderr, /ERROR set_secret STRIPE_SECRET_KY/); assert.match(cli.stderr, /WARN CI reads secrets.SENTRY_DSN/);
  const usage = spawnSync("node", [path.join(__dirname, "check-wizard.js"), w, "--repo", path.join(d, "missing")], { encoding: "utf8" });
  assert.strictEqual(usage.status, 2); }
console.log("wizard: all assertions passed");
