"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { REPOSITORY_INDEX_VERSION, CLASSIFICATION_POLICY_VERSION } = require("./repository-index");

const DUPLICATION_ANALYZER_VERSION = "sei.structural-duplication@1";
const TOKEN_POLICY_VERSION = "sei.type2-token-structure@1";
const MODULE_POLICY_VERSION = "sei.clone-module-resolution@1";
const ALGORITHM_VERSION = "sei.winnowed-bounded-token-clones@2";
const INTERPRETATION_BOUNDARY = "structural-investigation-signal-only-not-a-defect-or-causality-claim";
const SOURCE_MODES = new Set(["100644", "100755"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const INPUT_KEYS = new Set(["changeSignals", "configuration", "repositoryIndex", "signal"]);
const CONFIGURATION_KEYS = new Set([
  "highChangeMinCount",
  "largeFamilyMinDuplicatedLines",
  "maxCandidatePairs",
  "maxChangePaths",
  "maxCloneFamilies",
  "maxFileBytes",
  "maxFingerprintWindows",
  "maxOccurrencesPerFingerprint",
  "maxReadBatchBytes",
  "maxSimultaneousPairs",
  "maxSourceFiles",
  "maxTotalSourceBytes",
  "maxTotalTokens",
  "minSourceLines",
  "minTokens",
  "simultaneousChangeMinCount",
]);
const CHANGE_SIGNAL_KEYS = new Set([
  "evidence_digest",
  "path_changes",
  "repository_revision",
  "simultaneous_changes",
]);
const PATH_CHANGE_KEYS = new Set(["change_count", "path"]);
const SIMULTANEOUS_CHANGE_KEYS = new Set(["change_count", "left_path", "right_path"]);

const DEFAULT_CONFIGURATION = Object.freeze({
  minTokens: 24,
  minSourceLines: 4,
  largeFamilyMinDuplicatedLines: 40,
  highChangeMinCount: 10,
  simultaneousChangeMinCount: 2,
  maxSourceFiles: 20_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalSourceBytes: 64 * 1024 * 1024,
  maxTotalTokens: 2_000_000,
  maxFingerprintWindows: 2_000_000,
  maxOccurrencesPerFingerprint: 512,
  maxCandidatePairs: 250_000,
  maxCloneFamilies: 25_000,
  maxReadBatchBytes: 16 * 1024 * 1024,
  maxChangePaths: 100_000,
  maxSimultaneousPairs: 250_000,
});

const HARD_CONFIGURATION = Object.freeze({
  minTokens: 256,
  minSourceLines: 100,
  largeFamilyMinDuplicatedLines: 1_000_000,
  highChangeMinCount: Number.MAX_SAFE_INTEGER,
  simultaneousChangeMinCount: Number.MAX_SAFE_INTEGER,
  maxSourceFiles: 100_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalSourceBytes: 256 * 1024 * 1024,
  maxTotalTokens: 5_000_000,
  maxFingerprintWindows: 5_000_000,
  maxOccurrencesPerFingerprint: 512,
  maxCandidatePairs: 1_000_000,
  maxCloneFamilies: 100_000,
  maxReadBatchBytes: 32 * 1024 * 1024,
  maxChangePaths: 100_000,
  maxSimultaneousPairs: 1_000_000,
});

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "base", "bool", "boolean", "break", "by",
  "case", "catch", "char", "class", "const", "continue", "data", "def", "default",
  "delegate", "do", "double", "elif", "else", "enum", "except", "export", "extends",
  "false", "final", "finally", "float", "for", "foreach", "from", "fun", "function",
  "go", "goto", "if", "implements", "import", "in", "instanceof", "int", "interface",
  "internal", "is", "lambda", "let", "long", "match", "namespace", "native", "new",
  "nil", "none", "null", "object", "open", "operator", "out", "override", "package",
  "pass", "private", "protected", "public", "raise", "readonly", "record", "ref",
  "return", "sealed", "short", "static", "string", "struct", "super", "switch",
  "synchronized", "this", "throw", "throws", "trait", "true", "try", "type", "typeof",
  "uint", "ulong", "union", "unsafe", "using", "val", "var", "virtual", "void",
  "when", "where", "while", "with", "yield",
]);

const OPERATORS = Object.freeze([
  ">>>=", "<<=", ">>=", "**=", "...", "===", "!==", ">>>", "::", "=>", "->",
  "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=",
  "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**", "?:", "..",
]);

const C_STYLE_COMMENT_LANGUAGES = new Set([
  "c", "cpp", "csharp", "go", "java", "javascript", "kotlin", "php", "rust", "swift", "typescript",
]);
const HASH_COMMENT_LANGUAGES = new Set(["php", "python", "ruby"]);

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedRecord(value, keys, label, code = "FAIL-DUPLICATION-CONFIG") {
  if (!isRecord(value)) fail(code, `${label} must be a closed record`);
  const unexpected = Object.keys(value).filter((key) => !keys.has(key)).sort(stableCompare);
  if (unexpected.length > 0) fail(code, `${label} contains unexpected field ${unexpected[0]}`);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function roundRatio(numerator, denominator) {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(8));
}

function roundFraction(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(8));
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function checkCancelled(signal) {
  if (signal?.aborted) fail("FAIL-DUPLICATION-CANCELLED", "operation was cancelled");
}

function positiveBound(value, key, minimum = 1) {
  const hard = HARD_CONFIGURATION[key];
  if (!Number.isSafeInteger(value) || value < minimum || value > hard) {
    fail("FAIL-DUPLICATION-CONFIG", `${key} must be a safe integer from ${minimum} through ${hard}`);
  }
  return value;
}

function normalizeConfiguration(value) {
  if (value === undefined) value = {};
  assertClosedRecord(value, CONFIGURATION_KEYS, "configuration");
  const configuration = {};
  for (const key of Object.keys(DEFAULT_CONFIGURATION)) {
    const minimum = key === "minTokens" ? 8 : key === "minSourceLines" ? 2 : 1;
    configuration[key] = positiveBound(value[key] ?? DEFAULT_CONFIGURATION[key], key, minimum);
  }
  if (configuration.maxFileBytes > configuration.maxReadBatchBytes) {
    fail("FAIL-DUPLICATION-CONFIG", "maxFileBytes cannot exceed maxReadBatchBytes");
  }
  if (configuration.maxFileBytes > configuration.maxTotalSourceBytes) {
    fail("FAIL-DUPLICATION-CONFIG", "maxFileBytes cannot exceed maxTotalSourceBytes");
  }
  return deepFreeze(configuration);
}

function safeRepositoryPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")
      || value.startsWith("/") || /^[A-Za-z]:/.test(value)
      || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("FAIL-DUPLICATION-SIGNALS", `${label} must be a safe repository-relative POSIX path`);
  }
  return value;
}

function normalizeChangeSignals(value, binding, configuration) {
  if (value === undefined) return { signals: null, limitEvents: [] };
  assertClosedRecord(value, CHANGE_SIGNAL_KEYS, "changeSignals", "FAIL-DUPLICATION-SIGNALS");
  if (!SHA256.test(value.evidence_digest)) fail("FAIL-DUPLICATION-SIGNALS", "evidence_digest must be sha256-prefixed lowercase hex");
  if (value.repository_revision !== binding.repository_revision) {
    fail("FAIL-DUPLICATION-SIGNALS", "repository_revision must match the RepositoryIndex revision");
  }
  if (!Array.isArray(value.path_changes) || !Array.isArray(value.simultaneous_changes)) {
    fail("FAIL-DUPLICATION-SIGNALS", "path_changes and simultaneous_changes must be arrays");
  }
  const limitEvents = [];
  if (value.path_changes.length > configuration.maxChangePaths) {
    limitEvents.push({
      limit: "maxChangePaths",
      observed: value.path_changes.length,
      maximum: configuration.maxChangePaths,
      disposition: "unavailable-no-truncation",
    });
  }
  if (value.simultaneous_changes.length > configuration.maxSimultaneousPairs) {
    limitEvents.push({
      limit: "maxSimultaneousPairs",
      observed: value.simultaneous_changes.length,
      maximum: configuration.maxSimultaneousPairs,
      disposition: "unavailable-no-truncation",
    });
  }
  if (limitEvents.length > 0) {
    return {
      signals: deepFreeze({
        evidence_digest: value.evidence_digest,
        repository_revision: value.repository_revision,
        path_changes: [],
        simultaneous_changes: [],
        input_digest: null,
      }),
      limitEvents,
    };
  }
  const pathChanges = value.path_changes.map((item, index) => {
    assertClosedRecord(item, PATH_CHANGE_KEYS, `changeSignals.path_changes[${index}]`, "FAIL-DUPLICATION-SIGNALS");
    const filePath = safeRepositoryPath(item.path, `changeSignals.path_changes[${index}].path`);
    if (!Number.isSafeInteger(item.change_count) || item.change_count < 0) {
      fail("FAIL-DUPLICATION-SIGNALS", `changeSignals.path_changes[${index}].change_count must be nonnegative`);
    }
    return { path: filePath, change_count: item.change_count };
  }).sort((left, right) => stableCompare(left.path, right.path));
  if (new Set(pathChanges.map((item) => item.path)).size !== pathChanges.length) {
    fail("FAIL-DUPLICATION-SIGNALS", "path_changes paths must be unique");
  }
  const simultaneousChanges = value.simultaneous_changes.map((item, index) => {
    assertClosedRecord(item, SIMULTANEOUS_CHANGE_KEYS, `changeSignals.simultaneous_changes[${index}]`, "FAIL-DUPLICATION-SIGNALS");
    const leftPath = safeRepositoryPath(item.left_path, `changeSignals.simultaneous_changes[${index}].left_path`);
    const rightPath = safeRepositoryPath(item.right_path, `changeSignals.simultaneous_changes[${index}].right_path`);
    if (stableCompare(leftPath, rightPath) >= 0) {
      fail("FAIL-DUPLICATION-SIGNALS", "simultaneous-change paths must be distinct and canonical (left_path < right_path)");
    }
    if (!Number.isSafeInteger(item.change_count) || item.change_count < 0) {
      fail("FAIL-DUPLICATION-SIGNALS", `changeSignals.simultaneous_changes[${index}].change_count must be nonnegative`);
    }
    return { left_path: leftPath, right_path: rightPath, change_count: item.change_count };
  }).sort((left, right) => stableCompare(`${left.left_path}\0${left.right_path}`, `${right.left_path}\0${right.right_path}`));
  const pairKeys = simultaneousChanges.map((item) => `${item.left_path}\0${item.right_path}`);
  if (new Set(pairKeys).size !== pairKeys.length) fail("FAIL-DUPLICATION-SIGNALS", "simultaneous-change pairs must be unique");
  const normalized = {
    evidence_digest: value.evidence_digest,
    repository_revision: value.repository_revision,
    path_changes: pathChanges,
    simultaneous_changes: simultaneousChanges,
  };
  return {
    signals: deepFreeze({
      ...normalized,
      input_digest: sha256(Buffer.from(canonicalJson(normalized), "utf8")),
    }),
    limitEvents: [],
  };
}

function validateRepositoryIndex(index) {
  if (!index || typeof index !== "object" || !isRecord(index.binding) || !Array.isArray(index.entries)
      || !Array.isArray(index.exclusions) || typeof index.readBlobs !== "function") {
    fail("FAIL-DUPLICATION-INDEX", "repositoryIndex must be a landed immutable RepositoryIndex");
  }
  if (!Object.isFrozen(index) || !Object.isFrozen(index.binding) || !Object.isFrozen(index.entries)
      || !Object.isFrozen(index.exclusions)) {
    fail("FAIL-DUPLICATION-INDEX", "repositoryIndex, binding, entries, and exclusions must be immutable");
  }
  const binding = index.binding;
  const objectIdLength = binding.object_format === "sha1" ? 40 : binding.object_format === "sha256" ? 64 : 0;
  const objectId = new RegExp(`^[a-f0-9]{${objectIdLength}}$`);
  if (binding.index_version !== REPOSITORY_INDEX_VERSION
      || binding.classification_policy_version !== CLASSIFICATION_POLICY_VERSION
      || objectIdLength === 0 || !objectId.test(binding.repository_revision) || !objectId.test(binding.root_tree_oid)
      || !SHA256.test(binding.index_digest) || !SHA256.test(binding.classification_policy_hash)
      || !SHA256.test(binding.index_key) || binding.entry_count !== index.entries.length
      || binding.exclusion_count !== index.exclusions.length) {
    fail("FAIL-DUPLICATION-INDEX", "repositoryIndex binding identities are invalid");
  }
  let previousPath = null;
  let totalBlobBytes = 0;
  for (const entry of index.entries) {
    if (!Object.isFrozen(entry) || !Object.isFrozen(entry.classifications) || typeof entry.path !== "string"
        || typeof entry.byte_size !== "number" || !Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0
        || !isRecord(entry.classifications)) {
      fail("FAIL-DUPLICATION-INDEX", "repositoryIndex entries must be immutable classified records");
    }
    if (previousPath !== null && stableCompare(previousPath, entry.path) >= 0) {
      fail("FAIL-DUPLICATION-INDEX", "repositoryIndex entries must be unique and canonically ordered");
    }
    if (!objectId.test(entry.blob_oid) || !new Set(["100644", "100755", "120000"]).has(entry.mode)
        || typeof entry.language !== "string" || entry.language.length === 0
        || typeof entry.classifications.source !== "boolean"
        || !new Set(["generated", "human", "unknown"]).has(entry.classifications.generated)
        || !new Set(["vendor", "not-vendor"]).has(entry.classifications.vendor)) {
      fail("FAIL-DUPLICATION-INDEX", `repositoryIndex entry contract is invalid for ${entry.path}`);
    }
    totalBlobBytes += entry.byte_size;
    previousPath = entry.path;
  }
  if (!Number.isSafeInteger(totalBlobBytes) || totalBlobBytes !== binding.total_blob_bytes) {
    fail("FAIL-DUPLICATION-INDEX", "repositoryIndex total blob bytes disagree with its entries");
  }
}

function directoryName(filePath) {
  const directory = path.posix.dirname(filePath);
  return directory === "." ? "." : directory;
}

function manifestDirectories(entries) {
  return [...new Set(entries
    .filter((entry) => Array.isArray(entry.classifications.manifest_kinds)
      && entry.classifications.manifest_kinds.length > 0)
    .map((entry) => directoryName(entry.path)))]
    .sort((left, right) => right.split("/").length - left.split("/").length || stableCompare(left, right));
}

function isAncestor(directory, filePath) {
  return directory === "." || filePath.startsWith(`${directory}/`);
}

function resolveModule(filePath, directories) {
  const manifestDirectory = directories.find((directory) => isAncestor(directory, filePath));
  if (manifestDirectory !== undefined) return manifestDirectory;
  const slash = filePath.indexOf("/");
  return slash < 0 ? "." : filePath.slice(0, slash);
}

function selectSourceEntries(index, configuration) {
  const selected = [];
  const excluded = [];
  const policyExcluded = [];
  const analysisExcluded = [];
  let indexSourceEntryCount = 0;
  let eligibleSourceEntryCount = 0;
  let eligibleSourceBytes = 0;
  let totalBytes = 0;
  let partial = false;
  for (const entry of index.entries) {
    if (!entry.classifications.source || !SOURCE_MODES.has(entry.mode)) continue;
    indexSourceEntryCount += 1;
    let reason = null;
    if (entry.classifications.generated === "generated") reason = "generated";
    else if (entry.classifications.vendor === "vendor") reason = "vendor";
    else {
      eligibleSourceEntryCount += 1;
      eligibleSourceBytes += entry.byte_size;
    }
    if (reason === null && entry.classifications.generated !== "human") {
      reason = "generated-classification-unknown";
      partial = true;
    } else if (reason === null && entry.byte_size > configuration.maxFileBytes) {
      reason = "file-byte-limit";
      partial = true;
    }
    if (reason !== null) {
      const exclusion = { path: entry.path, byte_size: entry.byte_size, reason };
      excluded.push(exclusion);
      if (reason === "generated" || reason === "vendor") policyExcluded.push(exclusion);
      else analysisExcluded.push(exclusion);
      continue;
    }
    selected.push(entry);
    totalBytes += entry.byte_size;
  }
  const limitEvents = [];
  if (selected.length > configuration.maxSourceFiles) {
    limitEvents.push({
      limit: "maxSourceFiles",
      observed: selected.length,
      maximum: configuration.maxSourceFiles,
      disposition: "unavailable-no-truncation",
    });
  }
  if (totalBytes > configuration.maxTotalSourceBytes) {
    limitEvents.push({
      limit: "maxTotalSourceBytes",
      observed: totalBytes,
      maximum: configuration.maxTotalSourceBytes,
      disposition: "unavailable-no-truncation",
    });
  }
  return {
    selected,
    excluded,
    policyExcluded,
    analysisExcluded,
    indexSourceEntryCount,
    eligibleSourceEntryCount,
    eligibleSourceBytes,
    totalBytes,
    partial,
    limitEvents,
  };
}

function isIdentifierStart(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_" || character === "$" || code >= 128;
}

function isIdentifierPart(character) {
  if (isIdentifierStart(character)) return true;
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isDigit(character) {
  return character !== undefined && character >= "0" && character <= "9";
}

function scanNumber(text, start) {
  let cursor = start;
  if (text[cursor] === ".") {
    cursor += 1;
    while (isDigit(text[cursor]) || text[cursor] === "_") cursor += 1;
  } else if (text[cursor] === "0" && /[xXbBoO]/.test(text[cursor + 1] ?? "")) {
    cursor += 2;
    while (/[0-9A-Fa-f_]/.test(text[cursor] ?? "")) cursor += 1;
  } else {
    while (isDigit(text[cursor]) || text[cursor] === "_") cursor += 1;
    if (text[cursor] === "." && text[cursor + 1] !== ".") {
      cursor += 1;
      while (isDigit(text[cursor]) || text[cursor] === "_") cursor += 1;
    }
    if (text[cursor] === "e" || text[cursor] === "E") {
      let exponent = cursor + 1;
      if (text[exponent] === "+" || text[exponent] === "-") exponent += 1;
      if (isDigit(text[exponent])) {
        cursor = exponent + 1;
        while (isDigit(text[cursor]) || text[cursor] === "_") cursor += 1;
      }
    }
  }
  while (isIdentifierPart(text[cursor])) cursor += 1;
  return cursor;
}

function skipQuoted(text, offset, quote, line) {
  const triple = (quote === "\"" || quote === "'") && text.slice(offset, offset + 3) === quote.repeat(3);
  let cursor = offset + (triple ? 3 : 1);
  while (cursor < text.length) {
    if (text[cursor] === "\n") line += 1;
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (triple ? text.slice(cursor, cursor + 3) === quote.repeat(3) : text[cursor] === quote) {
      cursor += triple ? 3 : 1;
      return { cursor, line };
    }
    cursor += 1;
  }
  return { cursor, line };
}

function tokenize(text, language) {
  const tokens = [];
  const lines = [];
  const codeLines = new Set();
  const cStyleComments = C_STYLE_COMMENT_LANGUAGES.has(language);
  const hashComments = HASH_COMMENT_LANGUAGES.has(language);
  let cursor = 0;
  let line = 1;
  const emit = (token, tokenLine = line) => {
    tokens.push(token);
    lines.push(tokenLine);
    codeLines.add(tokenLine);
  };
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\n") {
      line += 1;
      cursor += 1;
      continue;
    }
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (cStyleComments && text.startsWith("//", cursor)) {
      const newline = text.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? text.length : newline;
      continue;
    }
    if (hashComments && character === "#") {
      const newline = text.indexOf("\n", cursor + 1);
      cursor = newline < 0 ? text.length : newline;
      continue;
    }
    if (cStyleComments && text.startsWith("/*", cursor)) {
      cursor += 2;
      while (cursor < text.length && !text.startsWith("*/", cursor)) {
        if (text[cursor] === "\n") line += 1;
        cursor += 1;
      }
      cursor = Math.min(text.length, cursor + 2);
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      const tokenLine = line;
      const skipped = skipQuoted(text, cursor, character, line);
      cursor = skipped.cursor;
      line = skipped.line;
      emit("L:string", tokenLine);
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = cursor + 1;
      while (isIdentifierPart(text[end])) end += 1;
      const identifier = text.slice(cursor, end);
      const lower = identifier.toLowerCase();
      emit(KEYWORDS.has(lower) ? `K:${lower}` : "I");
      cursor = end;
      continue;
    }
    if (isDigit(character) || (character === "." && isDigit(text[cursor + 1]))) {
      emit("L:number");
      cursor = scanNumber(text, cursor);
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, cursor));
    if (operator !== undefined) {
      emit(`P:${operator}`);
      cursor += operator.length;
      continue;
    }
    emit(`P:${character}`);
    cursor += 1;
  }
  return { tokens, lines, codeLines: [...codeLines].sort((left, right) => left - right) };
}

function batchEntries(entries, maximumBytes) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && bytes + entry.byte_size > maximumBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.byte_size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function loadSources(index, selection, configuration, signal, directories, telemetry) {
  const files = [];
  let totalTokens = 0;
  for (const batch of batchEntries(selection.selected, configuration.maxReadBatchBytes)) {
    checkCancelled(signal);
    const blobs = await index.readBlobs(batch, {
      max_blob_bytes: configuration.maxFileBytes,
      max_total_bytes: configuration.maxReadBatchBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    telemetry.blob_read_batches += 1;
    for (const entry of batch) {
      const bytes = blobs.get(entry.path);
      if (!Buffer.isBuffer(bytes)) fail("FAIL-DUPLICATION-BLOB", `missing blob bytes for ${entry.path}`);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        const exclusion = { path: entry.path, byte_size: entry.byte_size, reason: "invalid-utf8" };
        selection.excluded.push(exclusion);
        selection.analysisExcluded.push(exclusion);
        selection.partial = true;
        continue;
      }
      const tokenized = tokenize(text, entry.language);
      totalTokens += tokenized.tokens.length;
      if (totalTokens > configuration.maxTotalTokens) {
        return {
          files: [],
          totalTokens,
          limitEvent: {
            limit: "maxTotalTokens",
            observed: totalTokens,
            maximum: configuration.maxTotalTokens,
            disposition: "unavailable-no-truncation",
          },
        };
      }
      files.push({
        path: entry.path,
        module_id: resolveModule(entry.path, directories),
        language: entry.language,
        byte_size: entry.byte_size,
        tokens: tokenized.tokens,
        token_lines: tokenized.lines,
        code_lines: tokenized.codeLines,
      });
    }
  }
  return { files, totalTokens, limitEvent: null };
}

function hashToken(token, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function rollingHashes(tokens, windowSize, base, seed) {
  const values = tokens.map((token) => hashToken(token, seed));
  if (values.length < windowSize) return [];
  let power = 1;
  for (let index = 1; index < windowSize; index += 1) power = Math.imul(power, base) >>> 0;
  let hash = 0;
  for (let index = 0; index < windowSize; index += 1) hash = (Math.imul(hash, base) + values[index]) >>> 0;
  const hashes = [hash];
  for (let start = 1; start + windowSize <= values.length; start += 1) {
    hash = (hash - Math.imul(values[start - 1], power)) >>> 0;
    hash = (Math.imul(hash, base) + values[start + windowSize - 1]) >>> 0;
    hashes.push(hash);
  }
  return hashes;
}

function compareHashPair(first, second, left, right) {
  return first[left] - first[right] || second[left] - second[right];
}

function winnowedFingerprints(tokens, minimumTokens) {
  const gramSize = Math.max(8, Math.floor(minimumTokens / 2));
  const windowSize = minimumTokens - gramSize + 1;
  const first = rollingHashes(tokens, gramSize, 16777619, 2166136261);
  const second = rollingHashes(tokens, gramSize, 2246822519, 374761393);
  if (first.length < windowSize) return { fingerprints: [], gramSize, rawWindowCount: first.length };
  const deque = [];
  const fingerprints = [];
  let priorSelection = -1;
  for (let index = 0; index < first.length; index += 1) {
    while (deque.length > 0 && compareHashPair(first, second, index, deque[deque.length - 1]) <= 0) deque.pop();
    deque.push(index);
    const windowStart = index - windowSize + 1;
    while (deque[0] < windowStart) deque.shift();
    if (windowStart < 0 || deque[0] === priorSelection) continue;
    priorSelection = deque[0];
    fingerprints.push({
      key: `${first[priorSelection].toString(16).padStart(8, "0")}${second[priorSelection].toString(16).padStart(8, "0")}`,
      start: priorSelection,
    });
  }
  return { fingerprints, gramSize, rawWindowCount: first.length };
}

function buildFingerprintBuckets(files, configuration, telemetry) {
  const buckets = new Map();
  const occurrenceCounts = new Map();
  const suppressed = new Set();
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const winnowed = winnowedFingerprints(file.tokens, configuration.minTokens);
    telemetry.raw_fingerprint_windows += winnowed.rawWindowCount;
    for (const fingerprint of winnowed.fingerprints) {
      telemetry.fingerprint_windows += 1;
      if (telemetry.fingerprint_windows > configuration.maxFingerprintWindows) {
        telemetry.omitted_fingerprint_windows += 1;
        continue;
      }
      const key = fingerprint.key;
      const count = (occurrenceCounts.get(key) ?? 0) + 1;
      occurrenceCounts.set(key, count);
      if (suppressed.has(key)) continue;
      const bucket = buckets.get(key) ?? [];
      bucket.push({ fileIndex, length: winnowed.gramSize, start: fingerprint.start });
      if (count > configuration.maxOccurrencesPerFingerprint) {
        buckets.delete(key);
        suppressed.add(key);
        continue;
      }
      buckets.set(key, bucket);
    }
  }
  const limitEvents = [];
  if (telemetry.omitted_fingerprint_windows > 0) {
    limitEvents.push({
      limit: "maxFingerprintWindows",
      observed: telemetry.fingerprint_windows,
      maximum: configuration.maxFingerprintWindows,
      disposition: "partial-lower-bound",
      excluded_window_count: telemetry.omitted_fingerprint_windows,
    });
  }
  if (suppressed.size > 0) {
    const suppressedWindowCount = [...suppressed].reduce((count, key) => count + occurrenceCounts.get(key), 0);
    telemetry.suppressed_fingerprint_count = suppressed.size;
    telemetry.suppressed_fingerprint_windows = suppressedWindowCount;
    limitEvents.push({
      limit: "maxOccurrencesPerFingerprint",
      observed: Math.max(...[...suppressed].map((key) => occurrenceCounts.get(key))),
      maximum: configuration.maxOccurrencesPerFingerprint,
      disposition: "partial-lower-bound",
      excluded_fingerprint_count: suppressed.size,
      excluded_window_count: suppressedWindowCount,
    });
  }
  return { buckets, limitEvent: null, limitEvents };
}

function windowsOverlap(leftStart, rightStart, length) {
  return leftStart < rightStart + length && rightStart < leftStart + length;
}

function expandPair(files, left, right, minimumTokens) {
  const leftFile = files[left.fileIndex];
  const rightFile = files[right.fileIndex];
  if (left.fileIndex === right.fileIndex && windowsOverlap(left.start, right.start, minimumTokens)) return null;
  let leftStart = left.start;
  let rightStart = right.start;
  let leftEnd = left.start + minimumTokens;
  let rightEnd = right.start + minimumTokens;
  while (leftStart > 0 && rightStart > 0 && leftFile.tokens[leftStart - 1] === rightFile.tokens[rightStart - 1]) {
    leftStart -= 1;
    rightStart -= 1;
  }
  while (leftEnd < leftFile.tokens.length && rightEnd < rightFile.tokens.length
      && leftFile.tokens[leftEnd] === rightFile.tokens[rightEnd]) {
    leftEnd += 1;
    rightEnd += 1;
  }
  if (left.fileIndex === right.fileIndex && leftStart < rightEnd && rightStart < leftEnd) return null;
  return { leftStart, leftEnd, rightStart, rightEnd };
}

function occurrence(file, start, end) {
  const lineNumbers = new Set(file.token_lines.slice(start, end));
  return {
    path: file.path,
    module_id: file.module_id,
    start_line: file.token_lines[start],
    end_line: file.token_lines[end - 1],
    start_token: start,
    end_token_exclusive: end,
    source_line_count: lineNumbers.size,
  };
}

function occurrenceKey(value) {
  return `${value.path}\0${value.start_token.toString().padStart(12, "0")}\0${value.end_token_exclusive.toString().padStart(12, "0")}`;
}

function compareOccurrences(left, right) {
  return stableCompare(occurrenceKey(left), occurrenceKey(right));
}

function familySignals(occurrences, changeSignals, configuration) {
  if (changeSignals === null) {
    return {
      status: "unavailable",
      reason: "no revision-bound change signals were supplied",
      high_change_paths: [],
      simultaneous_change_pairs: [],
    };
  }
  const paths = new Set(occurrences.map((item) => item.path));
  const highChangePaths = changeSignals.path_changes
    .filter((item) => paths.has(item.path) && item.change_count >= configuration.highChangeMinCount);
  const simultaneousPairs = changeSignals.simultaneous_changes
    .filter((item) => paths.has(item.left_path) && paths.has(item.right_path)
      && item.change_count >= configuration.simultaneousChangeMinCount);
  return {
    status: "measured",
    reason: null,
    high_change_paths: highChangePaths,
    simultaneous_change_pairs: simultaneousPairs,
  };
}

function detectFamilies(files, configuration, changeSignals, telemetry) {
  const fingerprinted = buildFingerprintBuckets(files, configuration, telemetry);
  if (fingerprinted.limitEvent !== null) return { families: [], limitEvent: fingerprinted.limitEvent };
  const limitEvents = [...fingerprinted.limitEvents];
  const candidates = new Map();
  const expandedPairs = new Set();
  const bucketKeys = [...fingerprinted.buckets.keys()].sort(stableCompare);
  candidateGeneration:
  for (const bucketKey of bucketKeys) {
    checkCancelled(telemetry.signal);
    const bucket = fingerprinted.buckets.get(bucketKey);
    if (bucket.length < 2) continue;
    const exactGroups = new Map();
    for (const item of bucket) {
      const sequence = files[item.fileIndex].tokens.slice(item.start, item.start + item.length).join("\0");
      const group = exactGroups.get(sequence) ?? [];
      group.push(item);
      exactGroups.set(sequence, group);
    }
    for (const group of exactGroups.values()) {
      if (group.length < 2) continue;
      telemetry.repeated_fingerprint_groups += 1;
      for (let leftIndex = 0; leftIndex < group.length - 1; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
          const left = group[leftIndex];
          const right = group[rightIndex];
          if (left.fileIndex === right.fileIndex && windowsOverlap(left.start, right.start, left.length)) continue;
          const expanded = expandPair(files, left, right, left.length);
          if (expanded === null) continue;
          if (expanded.leftEnd - expanded.leftStart < configuration.minTokens) continue;
          const pairKey = [
            `${left.fileIndex}:${expanded.leftStart}:${expanded.leftEnd}`,
            `${right.fileIndex}:${expanded.rightStart}:${expanded.rightEnd}`,
          ].sort(stableCompare).join("\0");
          if (expandedPairs.has(pairKey)) continue;
          expandedPairs.add(pairKey);
          telemetry.candidate_pairs += 1;
          if (telemetry.candidate_pairs > configuration.maxCandidatePairs) {
            telemetry.candidate_pairs = configuration.maxCandidatePairs;
            limitEvents.push({
              limit: "maxCandidatePairs",
              observed: configuration.maxCandidatePairs + 1,
              maximum: configuration.maxCandidatePairs,
              disposition: "partial-lower-bound",
            });
            break candidateGeneration;
          }
          const leftOccurrence = occurrence(files[left.fileIndex], expanded.leftStart, expanded.leftEnd);
          const rightOccurrence = occurrence(files[right.fileIndex], expanded.rightStart, expanded.rightEnd);
          if (leftOccurrence.source_line_count < configuration.minSourceLines
              || rightOccurrence.source_line_count < configuration.minSourceLines) continue;
          const tokens = files[left.fileIndex].tokens.slice(expanded.leftStart, expanded.leftEnd);
          const structureDigest = sha256(Buffer.from(`${TOKEN_POLICY_VERSION}\0${tokens.join("\0")}`, "utf8"));
          const familyId = sha256(Buffer.from(`${DUPLICATION_ANALYZER_VERSION}\0${structureDigest}\0${tokens.length}`, "utf8"));
          let candidate = candidates.get(familyId);
          if (candidate === undefined) {
            if (candidates.size >= configuration.maxCloneFamilies) {
              limitEvents.push({
                limit: "maxCloneFamilies",
                observed: candidates.size + 1,
                maximum: configuration.maxCloneFamilies,
                disposition: "partial-lower-bound",
              });
              break candidateGeneration;
            }
            candidate = { familyId, structureDigest, tokens, occurrences: new Map() };
            candidates.set(familyId, candidate);
          } else if (candidate.tokens.length !== tokens.length
              || candidate.tokens.some((token, index) => token !== tokens[index])) {
            fail("FAIL-DUPLICATION-HASH-COLLISION", `structural digest collision for ${familyId}`);
          }
          candidate.occurrences.set(occurrenceKey(leftOccurrence), leftOccurrence);
          candidate.occurrences.set(occurrenceKey(rightOccurrence), rightOccurrence);
        }
      }
    }
  }
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const families = [...candidates.values()].map((candidate) => {
    const occurrences = [...candidate.occurrences.values()].sort(compareOccurrences);
    const modules = [...new Set(occurrences.map((item) => item.module_id))].sort(stableCompare);
    const duplicatedLinesByPath = new Map();
    for (const item of occurrences) {
      const lines = duplicatedLinesByPath.get(item.path) ?? new Set();
      for (const line of codeLinesInOccurrence(fileByPath.get(item.path), item)) lines.add(line);
      duplicatedLinesByPath.set(item.path, lines);
    }
    const duplicatedSourceLines = [...duplicatedLinesByPath.values()].reduce((count, lines) => count + lines.size, 0);
    return {
      family_id: candidate.familyId,
      structure_digest: candidate.structureDigest,
      token_count: candidate.tokens.length,
      occurrence_count: occurrences.length,
      duplicated_source_lines: duplicatedSourceLines,
      modules,
      cross_module: modules.length > 1,
      large_family: duplicatedSourceLines >= configuration.largeFamilyMinDuplicatedLines,
      investigation_signals: familySignals(occurrences, changeSignals, configuration),
      occurrences,
    };
  }).filter((family) => family.occurrence_count >= 2)
    .sort((left, right) => stableCompare(left.family_id, right.family_id));
  return { families, limitEvent: null, limitEvents };
}

function codeLinesInOccurrence(file, item) {
  return file.code_lines.filter((line) => line >= item.start_line && line <= item.end_line);
}

function exclusionCoverage(selection) {
  return {
    policy_excluded_source_entry_count: selection.policyExcluded.length,
    policy_excluded_source_bytes: selection.policyExcluded.reduce((count, entry) => count + entry.byte_size, 0),
    analysis_excluded_source_entry_count: selection.analysisExcluded.length,
    analysis_excluded_source_bytes: selection.analysisExcluded.reduce((count, entry) => count + entry.byte_size, 0),
  };
}

function measuredOutput(index, configuration, changeSignals, selection, files, families, telemetry) {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const duplicatedByPath = new Map(files.map((file) => [file.path, new Set()]));
  const crossModuleDuplicatedByPath = new Map(files.map((file) => [file.path, new Set()]));
  for (const family of families) {
    for (const item of family.occurrences) {
      const lines = codeLinesInOccurrence(fileByPath.get(item.path), item);
      for (const line of lines) duplicatedByPath.get(item.path).add(line);
      if (family.cross_module) for (const line of lines) crossModuleDuplicatedByPath.get(item.path).add(line);
    }
  }
  const analyzedSourceLines = files.reduce((count, file) => count + file.code_lines.length, 0);
  const duplicatedSourceLines = [...duplicatedByPath.values()].reduce((count, lines) => count + lines.size, 0);
  const crossModuleDuplicatedSourceLines = [...crossModuleDuplicatedByPath.values()].reduce((count, lines) => count + lines.size, 0);
  const moduleStatistics = new Map();
  for (const file of files) {
    const statistics = moduleStatistics.get(file.module_id) ?? {
      analyzed_source_files: 0,
      analyzed_source_lines: 0,
      duplicated_source_lines: 0,
      clone_family_count: 0,
      cross_module_clone_family_count: 0,
    };
    statistics.analyzed_source_files += 1;
    statistics.analyzed_source_lines += file.code_lines.length;
    statistics.duplicated_source_lines += duplicatedByPath.get(file.path).size;
    moduleStatistics.set(file.module_id, statistics);
  }
  for (const family of families) {
    for (const moduleId of family.modules) {
      const statistics = moduleStatistics.get(moduleId);
      statistics.clone_family_count += 1;
      if (family.cross_module) statistics.cross_module_clone_family_count += 1;
    }
  }
  const modules = [...moduleStatistics.keys()].sort(stableCompare).map((moduleId) => {
    const statistics = moduleStatistics.get(moduleId);
    return {
      module_id: moduleId,
      analyzed_source_files: statistics.analyzed_source_files,
      analyzed_source_lines: statistics.analyzed_source_lines,
      duplicated_source_lines: statistics.duplicated_source_lines,
      duplication_percentage: roundRatio(statistics.duplicated_source_lines, statistics.analyzed_source_lines),
      duplication_concentration: roundRatio(statistics.duplicated_source_lines, duplicatedSourceLines),
      clone_family_count: statistics.clone_family_count,
      cross_module_clone_family_count: statistics.cross_module_clone_family_count,
    };
  });
  const resourceLimited = telemetry.limit_events.some((event) => event.disposition === "partial-lower-bound");
  const partial = selection.partial || resourceLimited;
  const coverageStatus = partial ? "partial" : "complete";
  const status = files.length === 0 ? "unavailable" : partial ? "partial" : "measured";
  const observedDuplicationPercentage = roundRatio(duplicatedSourceLines, analyzedSourceLines);
  const analyzedSourceBytes = files.reduce((count, file) => count + file.byte_size, 0);
  const analyzedFingerprintWindows = telemetry.fingerprint_windows
    - telemetry.omitted_fingerprint_windows - telemetry.suppressed_fingerprint_windows;
  const reason = files.length === 0 ? "FAIL-DUPLICATION-NO-ANALYZABLE-SOURCE: no classified human UTF-8 source was analyzable"
    : resourceLimited ? "FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT: bounded candidate analysis retained lower-bound observations"
      : selection.partial ? "FAIL-DUPLICATION-PARTIAL-COVERAGE: one or more human source entries were not analyzable" : null;
  return finalize({
    analyzer: {
      analyzer_version: DUPLICATION_ANALYZER_VERSION,
      token_policy_version: TOKEN_POLICY_VERSION,
      module_policy_version: MODULE_POLICY_VERSION,
      algorithm_version: ALGORITHM_VERSION,
      algorithm_complexity: "O(T + S + F*B^2 + P*E + O), with sparse winnowed fingerprints S and postings B, expansions P, and outputs O bounded by configuration",
    },
    binding: binding(index, configuration, changeSignals),
    status,
    reason,
    termination: {
      kind: resourceLimited ? "resource-limited" : selection.partial ? "partial-coverage" : "complete",
      stage: resourceLimited ? "candidate-generation" : selection.partial ? "source-loading" : null,
      reason,
      limit_events: telemetry.limit_events.filter((event) => event.disposition === "partial-lower-bound"),
    },
    summary: {
      analyzed_source_files: files.length,
      analyzed_source_lines: analyzedSourceLines,
      clone_family_count: families.length,
      clone_occurrence_count: families.reduce((count, family) => count + family.occurrence_count, 0),
      duplicated_source_lines: duplicatedSourceLines,
      duplication_percentage: partial ? null : observedDuplicationPercentage,
      observed_duplication_percentage: observedDuplicationPercentage,
      cross_module_clone_family_count: families.filter((family) => family.cross_module).length,
      cross_module_duplicated_source_lines: crossModuleDuplicatedSourceLines,
      large_clone_family_count: families.filter((family) => family.large_family).length,
      high_change_clone_family_count: families.filter((family) => family.investigation_signals.high_change_paths.length > 0).length,
      simultaneous_change_clone_family_count: families.filter((family) => family.investigation_signals.simultaneous_change_pairs.length > 0).length,
    },
    modules,
    clone_families: families,
    coverage: {
      status: coverageStatus,
      index_source_entry_count: selection.indexSourceEntryCount,
      eligible_source_entry_count: selection.eligibleSourceEntryCount,
      eligible_source_bytes: selection.eligibleSourceBytes,
      analyzed_source_entry_count: files.length,
      analyzed_source_bytes: analyzedSourceBytes,
      analyzed_entry_ratio: roundFraction(files.length, selection.eligibleSourceEntryCount),
      analyzed_byte_ratio: roundFraction(analyzedSourceBytes, selection.eligibleSourceBytes),
      ...exclusionCoverage(selection),
      policy_excluded_entries: selection.policyExcluded.sort((left, right) => stableCompare(left.path, right.path)),
      analysis_excluded_entries: selection.analysisExcluded.sort((left, right) => stableCompare(left.path, right.path)),
      excluded_entries: selection.excluded.sort((left, right) => stableCompare(left.path, right.path)),
      candidate_space: {
        status: resourceLimited ? "partial" : "complete",
        fingerprint_window_count: telemetry.fingerprint_windows,
        analyzed_fingerprint_window_count: analyzedFingerprintWindows,
        fingerprint_coverage_ratio: roundFraction(analyzedFingerprintWindows, telemetry.fingerprint_windows),
        processed_candidate_pair_count: telemetry.candidate_pairs,
        suppressed_fingerprint_count: telemetry.suppressed_fingerprint_count,
        suppressed_fingerprint_window_count: telemetry.suppressed_fingerprint_windows,
        omitted_fingerprint_window_count: telemetry.omitted_fingerprint_windows,
      },
      lower_bound: partial,
    },
    telemetry: publicTelemetry(telemetry),
    interpretation_boundary: INTERPRETATION_BOUNDARY,
  });
}

function binding(index, configuration, changeSignals) {
  const configurationHash = sha256(Buffer.from(canonicalJson(configuration), "utf8"));
  const signalDigest = changeSignals === null ? null : changeSignals.evidence_digest;
  return {
    repository_index_version: index.binding.index_version,
    repository_revision: index.binding.repository_revision,
    root_tree_oid: index.binding.root_tree_oid,
    repository_index_digest: index.binding.index_digest,
    classification_policy_version: index.binding.classification_policy_version,
    classification_policy_hash: index.binding.classification_policy_hash,
    configuration_hash: configurationHash,
    change_signal_evidence_digest: signalDigest,
    change_signal_input_digest: changeSignals === null ? null : changeSignals.input_digest,
    analysis_key: sha256(Buffer.from(canonicalJson({
      analyzer_version: DUPLICATION_ANALYZER_VERSION,
      repository_index_version: index.binding.index_version,
      repository_revision: index.binding.repository_revision,
      root_tree_oid: index.binding.root_tree_oid,
      repository_index_digest: index.binding.index_digest,
      configuration_hash: configurationHash,
      change_signal_evidence_digest: signalDigest,
      change_signal_input_digest: changeSignals === null ? null : changeSignals.input_digest,
    }), "utf8")),
  };
}

function publicTelemetry(telemetry) {
  return {
    blob_read_batches: telemetry.blob_read_batches,
    token_count: telemetry.token_count,
    raw_fingerprint_windows: telemetry.raw_fingerprint_windows,
    fingerprint_windows: telemetry.fingerprint_windows,
    suppressed_fingerprint_count: telemetry.suppressed_fingerprint_count,
    suppressed_fingerprint_windows: telemetry.suppressed_fingerprint_windows,
    omitted_fingerprint_windows: telemetry.omitted_fingerprint_windows,
    repeated_fingerprint_groups: telemetry.repeated_fingerprint_groups,
    candidate_pairs: telemetry.candidate_pairs,
    limit_events: telemetry.limit_events,
  };
}

function unavailableOutput(index, configuration, changeSignals, selection, telemetry, reason) {
  return finalize({
    analyzer: {
      analyzer_version: DUPLICATION_ANALYZER_VERSION,
      token_policy_version: TOKEN_POLICY_VERSION,
      module_policy_version: MODULE_POLICY_VERSION,
      algorithm_version: ALGORITHM_VERSION,
      algorithm_complexity: "O(T + S + F*B^2 + P*E + O), with sparse winnowed fingerprints S and postings B, expansions P, and outputs O bounded by configuration",
    },
    binding: binding(index, configuration, changeSignals),
    status: "unavailable",
    reason,
    termination: {
      kind: reason.startsWith("FAIL-DUPLICATION-RESOURCE-LIMIT:") ? "resource-limited" : "unavailable",
      stage: reason.includes("input exceeds") ? "source-selection"
        : reason.includes("token inventory") ? "source-loading"
          : reason.includes("candidate space") ? "candidate-generation" : "source-eligibility",
      reason,
      limit_events: telemetry.limit_events,
    },
    summary: {
      analyzed_source_files: 0,
      analyzed_source_lines: null,
      clone_family_count: null,
      clone_occurrence_count: null,
      duplicated_source_lines: null,
      duplication_percentage: null,
      observed_duplication_percentage: null,
      cross_module_clone_family_count: null,
      cross_module_duplicated_source_lines: null,
      large_clone_family_count: null,
      high_change_clone_family_count: null,
      simultaneous_change_clone_family_count: null,
    },
    modules: [],
    clone_families: [],
    coverage: {
      status: "unavailable",
      index_source_entry_count: selection.indexSourceEntryCount,
      eligible_source_entry_count: selection.eligibleSourceEntryCount,
      eligible_source_bytes: selection.eligibleSourceBytes,
      analyzed_source_entry_count: 0,
      analyzed_source_bytes: 0,
      analyzed_entry_ratio: 0,
      analyzed_byte_ratio: 0,
      ...exclusionCoverage(selection),
      policy_excluded_entries: selection.policyExcluded.sort((left, right) => stableCompare(left.path, right.path)),
      analysis_excluded_entries: selection.analysisExcluded.sort((left, right) => stableCompare(left.path, right.path)),
      excluded_entries: selection.excluded.sort((left, right) => stableCompare(left.path, right.path)),
      candidate_space: {
        status: "unavailable",
        fingerprint_window_count: telemetry.fingerprint_windows,
        analyzed_fingerprint_window_count: 0,
        fingerprint_coverage_ratio: 0,
        processed_candidate_pair_count: 0,
        suppressed_fingerprint_count: telemetry.suppressed_fingerprint_count,
        suppressed_fingerprint_window_count: telemetry.suppressed_fingerprint_windows,
        omitted_fingerprint_window_count: telemetry.omitted_fingerprint_windows,
      },
      lower_bound: false,
    },
    telemetry: publicTelemetry(telemetry),
    interpretation_boundary: INTERPRETATION_BOUNDARY,
  });
}

function finalize(body) {
  const canonicalBody = canonicalValue(body);
  const resultDigest = sha256(Buffer.from(canonicalJson(canonicalBody), "utf8"));
  return deepFreeze(canonicalValue({ ...canonicalBody, result_digest: resultDigest }));
}

function projectDuplicationEvidence(input) {
  assertClosedRecord(input, new Set(["result", "configuration_hash", "history_window"]), "projection input");
  const result = input.result;
  if (!isRecord(result) || result.analyzer?.analyzer_version !== DUPLICATION_ANALYZER_VERSION
      || !isRecord(result.binding) || typeof result.result_digest !== "string"
      || !Array.isArray(result.clone_families) || !isRecord(result.summary)) {
    fail("FAIL-DUPLICATION-PROJECTION", "result is not a canonical duplication-intelligence artifact");
  }
  if (!/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "")) {
    fail("FAIL-DUPLICATION-PROJECTION", "configuration_hash must be a lowercase SHA-256 digest");
  }
  assertClosedRecord(input.history_window, new Set(["kind", "start", "end"]), "projection history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind)
      || input.history_window.end !== result.binding.repository_revision) {
    fail("FAIL-DUPLICATION-PROJECTION", "history_window must end at the analyzed repository revision");
  }
  const measured = result.status === "measured" || result.status === "partial";
  const collectorStatus = result.status === "measured" ? "available" : result.status === "partial" ? "degraded" : "unavailable";
  const collector = {
    collector_id: "structural-duplication-intelligence",
    collector_version: DUPLICATION_ANALYZER_VERSION,
    status: collectorStatus,
    analyzer_identity: DUPLICATION_ANALYZER_VERSION,
    analyzer_version: DUPLICATION_ANALYZER_VERSION,
    reason: collectorStatus === "available" ? null : result.reason,
  };
  const definitions = [
    ["analyzed_source_lines", "lines", result.summary.analyzed_source_lines],
    ["clone_family_count", "families", result.summary.clone_family_count],
    ["clone_occurrence_count", "occurrences", result.summary.clone_occurrence_count],
    ["duplicated_source_lines", "lines", result.summary.duplicated_source_lines],
    ["percentage", "ratio", result.summary.duplication_percentage],
    ["observed_percentage", "ratio", result.summary.observed_duplication_percentage],
    ["cross_module_clone_family_count", "families", result.summary.cross_module_clone_family_count],
    ["large_clone_family_count", "families", result.summary.large_clone_family_count],
  ];
  const refs = [`duplication-result:${result.result_digest}`, `repository-index:${result.binding.repository_index_digest}`];
  const metrics = definitions.map(([name, unit, value]) => {
    const metricMeasured = measured && value !== null;
    const observedCoverage = result.coverage.status === "complete"
      ? 1
      : Math.max(0, Math.min(1, Number(result.coverage.analyzed_entry_ratio ?? 0)));
    const metricReason = metricMeasured ? result.reason
      : name === "percentage" && result.status === "partial"
        ? "repository-wide duplication percentage is unavailable because observed clone facts are a lower bound"
        : result.reason;
    return {
      metric_id: `static.duplication.${name}`,
      definition_id: `sei.static.duplication.${name}@1`,
      family: "structural_duplication",
      subject: "repository:committed-index",
      repository_revision: result.binding.repository_revision,
      value: metricMeasured ? value : null,
      unit,
      measurement: {
        status: metricMeasured ? "measured" : "unavailable",
        // Partial duplication facts are useful lower bounds. Preserve their
        // bounded coverage instead of zeroing completeness and making the
        // semantic evidence layer discard every observed clone fact.
        completeness: metricMeasured ? observedCoverage : 0,
        confidence: metricMeasured ? Number((observedCoverage * 0.9).toFixed(8)) : 0,
        reason: metricReason,
      },
      source: {
        kind: "exact-git-token-structural-clones",
        collector_id: collector.collector_id,
        collector_version: collector.collector_version,
        repository_revision: result.binding.repository_revision,
        command: null,
        artifact_refs: refs,
        evidence_refs: refs,
      },
      scope: { kind: "repository", path: ".", language: null, generated_code: false, included_in_human_maintainability: true },
      window: structuredClone(input.history_window),
      analyzer_identity: DUPLICATION_ANALYZER_VERSION,
      analyzer_version: DUPLICATION_ANALYZER_VERSION,
      comparability: {
        analyzer_identity: DUPLICATION_ANALYZER_VERSION,
        analyzer_version: DUPLICATION_ANALYZER_VERSION,
        configuration_hash: input.configuration_hash,
        compatible_with_prior: false,
        reason: "no prior analyzer-bound duplication measurement was supplied",
      },
    };
  }).sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const cloneFamilies = result.clone_families
    .slice()
    .sort((left, right) => right.duplicated_source_lines - left.duplicated_source_lines || stableCompare(left.family_id, right.family_id))
    .slice(0, 25);
  return deepFreeze(canonicalValue({ collectors: [collector], metrics, clone_families: cloneFamilies, result }));
}

async function analyzeDuplicationIntelligence(input) {
  assertClosedRecord(input, INPUT_KEYS, "input");
  validateRepositoryIndex(input.repositoryIndex);
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    fail("FAIL-DUPLICATION-CONFIG", "signal must be an AbortSignal");
  }
  checkCancelled(input.signal);
  const configuration = normalizeConfiguration(input.configuration);
  const index = input.repositoryIndex;
  const normalizedChangeSignals = normalizeChangeSignals(input.changeSignals, index.binding, configuration);
  const changeSignals = normalizedChangeSignals.signals;
  const selection = selectSourceEntries(index, configuration);
  const telemetry = {
    signal: input.signal,
    blob_read_batches: 0,
    token_count: 0,
    raw_fingerprint_windows: 0,
    fingerprint_windows: 0,
    suppressed_fingerprint_count: 0,
    suppressed_fingerprint_windows: 0,
    omitted_fingerprint_windows: 0,
    repeated_fingerprint_groups: 0,
    candidate_pairs: 0,
    limit_events: [...selection.limitEvents, ...normalizedChangeSignals.limitEvents],
  };
  if (telemetry.limit_events.length > 0) {
    return unavailableOutput(index, configuration, changeSignals, selection, telemetry,
      "FAIL-DUPLICATION-RESOURCE-LIMIT: analysis input exceeds configured limits");
  }
  const token = `${index.binding.repository_revision}\0${index.binding.index_digest}`;
  const directories = manifestDirectories(index.entries);
  const loaded = await loadSources(index, selection, configuration, input.signal, directories, telemetry);
  telemetry.token_count = loaded.totalTokens;
  if (loaded.limitEvent !== null) {
    telemetry.limit_events.push(loaded.limitEvent);
    return unavailableOutput(index, configuration, changeSignals, selection, telemetry,
      "FAIL-DUPLICATION-RESOURCE-LIMIT: normalized token inventory exceeds configured limits");
  }
  if (loaded.files.length === 0) {
    return unavailableOutput(index, configuration, changeSignals, selection, telemetry,
      "FAIL-DUPLICATION-NO-ANALYZABLE-SOURCE: no classified human UTF-8 source was analyzable");
  }
  checkCancelled(input.signal);
  if (`${index.binding.repository_revision}\0${index.binding.index_digest}` !== token) {
    fail("FAIL-DUPLICATION-INDEX", "RepositoryIndex binding changed during analysis");
  }
  const detected = detectFamilies(loaded.files, configuration, changeSignals, telemetry);
  if (detected.limitEvent !== null) {
    telemetry.limit_events.push(detected.limitEvent);
    return unavailableOutput(index, configuration, changeSignals, selection, telemetry,
      "FAIL-DUPLICATION-RESOURCE-LIMIT: clone candidate space exceeds configured limits");
  }
  telemetry.limit_events.push(...detected.limitEvents);
  checkCancelled(input.signal);
  return measuredOutput(index, configuration, changeSignals, selection, loaded.files, detected.families, telemetry);
}

module.exports = {
  DUPLICATION_ANALYZER_VERSION,
  analyzeDuplicationIntelligence,
  projectDuplicationEvidence,
};
