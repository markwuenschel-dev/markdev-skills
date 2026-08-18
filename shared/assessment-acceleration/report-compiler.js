"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function safeJsonForScript(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function replaceRequired(source, marker, replacement) {
  const first = source.indexOf(marker);
  if (first === -1) throw new Error("REPORT_MARKER_MISSING:" + marker);
  if (source.indexOf(marker, first + marker.length) !== -1) throw new Error("REPORT_MARKER_DUPLICATE:" + marker);
  return source.slice(0, first) + replacement + source.slice(first + marker.length);
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
  return filePath;
}

function compileTemplate({ template, replacements, output }) {
  const started = process.hrtime.bigint();
  let source = fs.readFileSync(template, "utf8");
  for (const [marker, replacement] of Object.entries(replacements || {})) source = replaceRequired(source, marker, replacement);
  atomicWrite(output, source);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { output: path.resolve(output), bytes: Buffer.byteLength(source), sha256: crypto.createHash("sha256").update(source).digest("hex"), compile_elapsed_ms: Number(elapsedMs.toFixed(3)) };
}

module.exports = { escapeHtml, safeJsonForScript, replaceRequired, atomicWrite, compileTemplate };
