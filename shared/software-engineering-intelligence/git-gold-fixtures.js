"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runGit(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  if (result.error || result.status !== 0) {
    if (options.allowFailure) return result;
    throw new Error(`gold Git fixture command failed: git ${args.join(" ")} (${result.stderr || result.error?.message || result.status})`);
  }
  return result.stdout.trim();
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createGitGoldFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-gold-git-"));
  try {
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.email", "gold@example.test"]);
    runGit(root, ["config", "user.name", "SEI Gold Fixture"]);

    let second = 0;
    const commit = (message) => {
      const timestamp = `2026-08-01T00:00:${String(second).padStart(2, "0")}Z`;
      second += 1;
      runGit(root, ["add", "--all"]);
      runGit(root, ["commit", "--quiet", "-m", message], {
        env: { GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
      });
      return runGit(root, ["rev-parse", "HEAD"]);
    };

    write(root, "src/old.js", "export const oldName = true;\n");
    write(root, "src/paired.js", "export const paired = 1;\n");
    write(root, "src/deleted.js", "export const deleted = true;\n");
    const seed = commit("seed text files");

    write(root, "assets/blob.bin", Buffer.from([0, 1, 2, 3]));
    write(root, "src/café.js", "export const unicodePath = true;\n");
    const binary = commit("binary and unicode path");

    runGit(root, ["mv", "src/old.js", "src/renamed.js"]);
    write(root, "src/paired.js", "export const paired = 2;\n");
    const rename = commit("rename and paired text change");

    fs.rmSync(path.join(root, "src", "deleted.js"));
    write(root, "src/paired.js", "export const paired = 3;\n");
    const deletion = commit("delete and paired text change");

    const primaryBranch = runGit(root, ["branch", "--show-current"]);
    runGit(root, ["checkout", "--quiet", "-b", "feature"]);
    write(root, "src/feature.js", "export const feature = true;\n");
    const feature = commit("feature branch text change");

    runGit(root, ["checkout", "--quiet", primaryBranch]);
    write(root, "src/primary.js", "export const primary = true;\n");
    const primary = commit("primary branch text change");
    const mergeTimestamp = `2026-08-01T00:00:${String(second).padStart(2, "0")}Z`;
    second += 1;
    runGit(root, ["merge", "--quiet", "--no-ff", "feature", "-m", "merge feature branch"], {
      env: { GIT_AUTHOR_DATE: mergeTimestamp, GIT_COMMITTER_DATE: mergeTimestamp },
    });
    const merge = runGit(root, ["rev-parse", "HEAD"]);

    write(root, "src/reverted.js", "export const reversible = true;\n");
    const revertTarget = commit("revert target text change");
    const revertTimestamp = `2026-08-01T00:00:${String(second).padStart(2, "0")}Z`;
    runGit(root, ["revert", "--quiet", "--no-edit", revertTarget], {
      env: { GIT_AUTHOR_DATE: revertTimestamp, GIT_COMMITTER_DATE: revertTimestamp },
    });
    const revert = runGit(root, ["rev-parse", "HEAD"]);

    return {
      root,
      revisions: { seed, binary, rename, deletion, feature, primary, merge, revertTarget, revert },
      expected: {
        history_window_commit_count: 8,
        relationships: [
          ["assets/blob.bin", "src/café.js"],
          ["src/deleted.js", "src/paired.js"],
          ["src/paired.js", "src/renamed.js"],
        ],
        binary_file: "assets/blob.bin",
        rename_source: "src/old.js",
        rename_target: "src/renamed.js",
        deleted_file: "src/deleted.js",
        revert_file: "src/reverted.js",
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function createConflictMergeGoldFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-gold-git-conflict-"));
  try {
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.email", "gold@example.test"]);
    runGit(root, ["config", "user.name", "SEI Gold Fixture"]);

    let second = 0;
    const commit = (message) => {
      const timestamp = `2026-08-02T00:00:${String(second).padStart(2, "0")}Z`;
      second += 1;
      runGit(root, ["add", "--all"]);
      runGit(root, ["commit", "--quiet", "-m", message], {
        env: { GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
      });
      return runGit(root, ["rev-parse", "HEAD"]);
    };

    write(root, "src/conflict.js", "export const value = 'base';\n");
    const seed = commit("seed conflicting file");
    const primaryBranch = runGit(root, ["branch", "--show-current"]);
    runGit(root, ["checkout", "--quiet", "-b", "feature"]);
    write(root, "src/conflict.js", "export const value = 'feature';\n");
    const feature = commit("feature changes conflicting file");

    runGit(root, ["checkout", "--quiet", primaryBranch]);
    write(root, "src/conflict.js", "export const value = 'primary';\n");
    const primary = commit("primary changes conflicting file");
    const mergeTimestamp = `2026-08-02T00:00:${String(second).padStart(2, "0")}Z`;
    second += 1;
    const conflict = runGit(root, ["merge", "--no-ff", "feature", "-m", "merge feature with conflict"], {
      env: { GIT_AUTHOR_DATE: mergeTimestamp, GIT_COMMITTER_DATE: mergeTimestamp },
      allowFailure: true,
    });
    if (conflict.error || conflict.status !== 1) {
      throw new Error("gold Git fixture expected a deterministic merge conflict");
    }
    write(root, "src/conflict.js", "export const value = 'resolved';\n");
    const merge = commit("resolve merge conflict");

    return {
      root,
      revisions: { seed, feature, primary, merge },
      expected: {
        history_window_commit_count: 3,
        conflict_file: "src/conflict.js",
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function removeGitGoldFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

module.exports = { createConflictMergeGoldFixture, createGitGoldFixture, removeGitGoldFixture };
