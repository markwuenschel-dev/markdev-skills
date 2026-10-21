"use strict";
const fs = require("fs"), path = require("path");
const GENERATED_DIRECTORIES = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", "dist", "build", "coverage"]);
const GENERATED_FILES = new Set([".coverage", ".DS_Store", "Thumbs.db"]);
function scan(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (GENERATED_DIRECTORIES.has(entry.name)) found.push({ path: target, kind: "generated-directory" });
      else scan(target, found);
    } else if (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo") || GENERATED_FILES.has(entry.name))) {
      found.push({ path: target, kind: "generated-file" });
    }
  }
}
function check(root) {
  const found = [];
  scan(root, found);
  return { ok: found.length === 0, policy: { generated_directories: [...GENERATED_DIRECTORIES].sort(), generated_file_suffixes: [".pyc", ".pyo"], generated_files: [...GENERATED_FILES] }, artifacts: found.sort((a, b) => a.path.localeCompare(b.path)) };
}
if (require.main === module) { const result = check(process.argv[2] || path.resolve(__dirname, "..", "..")); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
module.exports = { check };
