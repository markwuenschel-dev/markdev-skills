"use strict";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function tinyFileTrapHistory() {
  const commits = Array.from({ length: 80 }, (_, index) => ({
    revision: index.toString(16).padStart(40, "0"),
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    author: index % 4 === 0 ? "maintainer@example.test" : "owner@example.test",
    files: [
      { path: "src/tiny.js", added: 1, deleted: index % 2 },
      { path: "src/companion.js", added: 2, deleted: 1 },
    ],
  }));

  return {
    repo_root: "fixture://tiny-file-trap",
    repository_revision: REVISION,
    history_window: {
      kind: "revision-range",
      start: commits[0].revision,
      end: commits.at(-1).revision,
    },
    commits,
  };
}

function generatedCodeTrap() {
  return {
    repo_root: "fixture://generated-code-trap",
    repository_revision: REVISION,
    generated_path_patterns: ["generated/**"],
    files: [
      {
        path: "src/maintained.js",
        content: "function maintained(value) {\n  if (value) return value;\n  return null;\n}\n",
      },
      {
        path: "generated/client.js",
        content: "function generated(a) {\n  if (a) {\n    if (a.b) {\n      if (a.b.c) return a.b.c;\n    }\n  }\n}\n",
      },
    ],
  };
}

function emptyHistoryWindow() {
  return {
    repo_root: "fixture://empty-history",
    repository_revision: REVISION,
    history_window: { kind: "revision-range", start: "a".repeat(40), end: REVISION },
    commits: [],
  };
}

function malformedHistory() {
  return {
    repo_root: "fixture://malformed-history",
    repository_revision: REVISION,
    commits: [{ revision: "bad", timestamp: "not-a-date", files: "src/index.js" }],
  };
}

function monorepoSources() {
  return {
    repo_root: "fixture://monorepo",
    repository_revision: REVISION,
    generated_path_patterns: ["packages/generated/**"],
    files: [
      { path: "packages/api/main.py", content: "def handler(value):\n    return value\n" },
      { path: "packages/web/index.ts", content: "export function render() { return 'ok'; }\n" },
      { path: "packages/generated/client.ts", content: "export function client() { return 'generated'; }\n" },
    ],
  };
}

function noGeneratedRuleSources() {
  return {
    repo_root: "fixture://no-generated-rule",
    repository_revision: REVISION,
    files: [
      { path: "src/human.js", content: "export const human = true;\n", generated: false },
      { path: "src/declared-generated.js", content: "export const generated = true;\n", generated: true },
      { path: "src/unknown.js", content: "export const unknown = true;\n" },
    ],
  };
}

module.exports = {
  REVISION,
  emptyHistoryWindow,
  generatedCodeTrap,
  malformedHistory,
  monorepoSources,
  noGeneratedRuleSources,
  tinyFileTrapHistory,
};
