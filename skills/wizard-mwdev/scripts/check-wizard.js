#!/usr/bin/env node
// Static check for a generated wizard. Proves structure only, never that a dashboard step is current.
// Usage: node check-wizard.js <wizard.sh> [--template <template.sh>] [--repo <dir>]   exit 0 ok, 1 errors, 2 usage
//   --repo  compare set_secret names with secrets.* references in <dir>/.github/workflows:
//           a secret the wizard sets that CI never reads is an error (likely a typo);
//           a secret CI reads that the wizard never sets is a warning (it may be set elsewhere).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MARKER = "# STAGES: author this section.";

function libraryOf(text) {
  const i = text.indexOf(MARKER);
  return i < 0 ? null : text.slice(0, i).replace(/\r/g, "");
}

function check(file, templateFile) {
  const errors = [];
  const text = fs.readFileSync(file, "utf8");
  const syntax = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (syntax.error) errors.push(`bash not runnable: ${syntax.error.message}`);
  else if (syntax.status !== 0) errors.push(`bash -n failed: ${syntax.stderr.trim()}`);

  const lib = libraryOf(text);
  const canon = libraryOf(fs.readFileSync(templateFile, "utf8"));
  if (lib === null) errors.push(`missing STAGES marker: ${MARKER}`);
  else if (lib !== canon) {
    const a = lib.split("\n"), b = canon.split("\n");
    const at = a.findIndex((l, i) => l !== b[i]);
    errors.push(`library above the STAGES marker differs from the template (first difference at line ${at + 1})`);
  }

  const stages = text.slice(text.indexOf(MARKER) + 1);
  const totals = [...stages.matchAll(/^\s*TOTAL_STAGES=(\S+)\s*$/gm)].map((m) => m[1]);
  const calls = [...stages.matchAll(/^\s*stage\s+["']/gm)].length;
  if (totals.length !== 1) errors.push(`expected exactly one TOTAL_STAGES= below the marker, found ${totals.length}`);
  else if (!/^\d+$/.test(totals[0])) errors.push(`TOTAL_STAGES must be a literal number, got ${totals[0]}`);
  else if (Number(totals[0]) !== calls) errors.push(`TOTAL_STAGES=${totals[0]} but ${calls} stage calls`);
  if (calls === 0) errors.push("no stage calls");
  if (!/^run_wizard\(\)\s*\{/m.test(stages)) errors.push("missing run_wizard() below the marker");
  if (!/^\s*finish\s*$/m.test(stages)) errors.push("run_wizard must end by calling finish");
  if (!/^run_wizard "\$@"; exit\s*$/m.test(stages)) errors.push("last line must stay: run_wizard \"$@\"; exit");
  // The template's example is identified by its own verbatim lines, so a real Stripe wizard is not mistaken for it.
  const EXAMPLE = [/^# ── Example stage: replace with your real steps/m, /^say "We'll grab your Stripe test keys and store them for local dev \+ CI\."$/m];
  if (EXAMPLE.some((re) => re.test(stages)) && path.resolve(file) !== path.resolve(templateFile)) errors.push("example Stripe stage left in place");
  return errors;
}

// Names GitHub provides itself; a wizard never sets these.
const BUILTIN_SECRETS = new Set(["GITHUB_TOKEN"]);

function ciSecrets(repo) {
  const dir = path.join(repo, ".github", "workflows");
  const names = new Set();
  if (!fs.existsSync(dir)) return names;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (!BUILTIN_SECRETS.has(m[1])) names.add(m[1]);
    for (const m of text.matchAll(/\bsecrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) if (!BUILTIN_SECRETS.has(m[1])) names.add(m[1]);
  }
  return names;
}

function crossCheckSecrets(file, repo) {
  const text = fs.readFileSync(file, "utf8");
  const stages = text.slice(Math.max(0, text.indexOf(MARKER)));
  const set = new Set([...stages.matchAll(/^\s*set_secret\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm)].map((m) => m[1]));
  const ci = ciSecrets(repo);
  const errors = [...set].filter((n) => !ci.has(n)).map((n) => `set_secret ${n} is never read by CI (.github/workflows has no secrets.${n})`);
  const warnings = [...ci].filter((n) => !set.has(n)).map((n) => `CI reads secrets.${n} but the wizard never sets it`);
  return { errors, warnings };
}

function main(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--template") opts.template = argv[++i];
    else if (argv[i] === "--repo") opts.repo = argv[++i];
    else rest.push(argv[i]);
  }
  const templateFile = opts.template || path.join(__dirname, "..", "template.sh");
  const file = rest[0];
  if (rest.length !== 1 || !fs.existsSync(file) || !fs.existsSync(templateFile) || (opts.repo !== undefined && !fs.existsSync(opts.repo))) {
    process.stderr.write("usage: check-wizard.js <wizard.sh> [--template <template.sh>] [--repo <dir>]\n"); return 2;
  }
  const errors = check(file, templateFile);
  if (opts.repo) {
    const x = crossCheckSecrets(file, opts.repo);
    errors.push(...x.errors);
    for (const w of x.warnings) process.stderr.write(`WARN ${w}\n`);
  }
  for (const e of errors) process.stderr.write(`ERROR ${e}\n`);
  if (!errors.length) process.stdout.write("OK wizard structure\n");
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { check, crossCheckSecrets };
