#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const ANALYZER_VERSION = "sei.tsjs-ast@1";
const PROTOCOL_VERSION = "sei.tsjs-ast@1";
const REQUEST_MAGIC = Buffer.from("SEITJA1\0", "ascii");
const RESPONSE_MAGIC = Buffer.from("SEITJR1\0", "ascii");
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 65 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_FACTS_PER_FILE = 100_000;
const MAX_STRING = 4096;
const SUPPORTED_SYNTAX = Object.freeze(["javascript", "jsx", "typescript", "tsx"]);

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
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

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("FAIL-TSJS-AST-REQUEST", `${label} must be an object`);
  const actual = Object.keys(value).sort(stableCompare);
  const expected = [...keys].sort(stableCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("FAIL-TSJS-AST-REQUEST", `${label} fields are invalid`);
  }
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("FAIL-TSJS-AST-REQUEST", `${label} must be a safe integer >= ${minimum}`);
}

function boundedString(value, label, { nullable = false, maximum = MAX_STRING } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    fail("FAIL-TSJS-AST-REQUEST", `${label} is invalid`);
  }
}

function analyzerDigest() {
  return sha256(fs.readFileSync(__filename));
}

function resolveTypeScriptPath(argument) {
  if (argument) {
    if (!path.isAbsolute(argument) || argument.includes("\0")) return null;
    try {
      if (!fs.statSync(argument).isFile()) return null;
      return path.resolve(argument);
    } catch {
      return null;
    }
  }
  try {
    return require.resolve("typescript", { paths: [__dirname] });
  } catch {
    return null;
  }
}

function loadRuntime(argument) {
  const base = {
    analyzer_sha256: analyzerDigest(),
    node_version: process.version,
    script_kinds: [],
    status: "unavailable",
    typescript_sha256: null,
    typescript_version: null,
  };
  const resolved = resolveTypeScriptPath(argument);
  if (resolved === null) return { runtime: base, reason: "typescript-compiler-api-not-found", ts: null };
  let ts;
  try {
    ts = require(resolved);
  } catch {
    return { runtime: base, reason: "typescript-compiler-api-load-failed", ts: null };
  }
  const requiredFunctions = [
    "createSourceFile", "flattenDiagnosticMessageText", "forEachChild",
    "isArrowFunction", "isBinaryExpression", "isBreakStatement", "isCallExpression", "isCaseClause",
    "isCatchClause", "isClassDeclaration", "isClassExpression", "isConditionalExpression",
    "isConstructorDeclaration", "isContinueStatement", "isDoStatement", "isElementAccessExpression",
    "isExportAssignment", "isExportDeclaration", "isExternalModuleReference", "isForInStatement",
    "isForOfStatement", "isForStatement", "isFunctionExpression", "isFunctionLike",
    "isGetAccessorDeclaration", "isIdentifier", "isIfStatement", "isImportDeclaration",
    "isImportEqualsDeclaration", "isImportTypeNode", "isInterfaceDeclaration", "isLiteralTypeNode",
    "isMethodDeclaration", "isNamedExports", "isNamedImports", "isNamespaceImport", "isNumericLiteral",
    "isPropertyAccessExpression", "isPropertyAssignment", "isSetAccessorDeclaration", "isStringLiteralLike",
    "isSwitchStatement", "isTypeAliasDeclaration", "isVariableDeclaration", "isVariableStatement",
    "isWhileStatement", "isWithStatement",
  ];
  if (!ts || requiredFunctions.some((name) => typeof ts[name] !== "function")
      || typeof ts.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(ts.version)
      || !ts.ScriptKind || !ts.ScriptTarget || !ts.SyntaxKind
      || [ts.ScriptKind.JS, ts.ScriptKind.JSX, ts.ScriptKind.TS, ts.ScriptKind.TSX, ts.ScriptTarget.Latest]
        .some((value) => !Number.isSafeInteger(value))) {
    return { runtime: base, reason: "typescript-compiler-api-incompatible", ts: null };
  }
  const major = Number.parseInt(ts.version.split(".")[0], 10);
  if (!Number.isSafeInteger(major) || major < 5 || major > 6) {
    return { runtime: base, reason: "typescript-compiler-api-version-unsupported", ts: null };
  }
  return {
    runtime: {
      ...base,
      script_kinds: [...SUPPORTED_SYNTAX],
      status: "available",
      typescript_sha256: sha256(fs.readFileSync(resolved)),
      typescript_version: ts.version,
    },
    reason: null,
    ts,
  };
}

function probe(runtimeState) {
  return {
    analyzer_sha256: runtimeState.runtime.analyzer_sha256,
    analyzer_version: ANALYZER_VERSION,
    node_version: runtimeState.runtime.node_version,
    protocol: PROTOCOL_VERSION,
    reason: runtimeState.reason,
    script_kinds: runtimeState.runtime.script_kinds,
    status: runtimeState.runtime.status,
    typescript_sha256: runtimeState.runtime.typescript_sha256,
    typescript_version: runtimeState.runtime.typescript_version,
  };
}

async function readStdinBounded() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) fail("FAIL-TSJS-AST-REQUEST", `stdin exceeded ${MAX_INPUT_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeRequest(frame) {
  if (frame.length < 12 || !frame.subarray(0, 8).equals(REQUEST_MAGIC)) fail("FAIL-TSJS-AST-REQUEST", "request magic is invalid");
  const headerLength = frame.readUInt32BE(8);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || frame.length < 12 + headerLength) {
    fail("FAIL-TSJS-AST-REQUEST", "request header length is invalid");
  }
  const headerBytes = frame.subarray(12, 12 + headerLength);
  let header;
  try { header = JSON.parse(headerBytes.toString("utf8")); } catch { fail("FAIL-TSJS-AST-REQUEST", "request header is not JSON"); }
  if (canonicalJson(header) !== headerBytes.toString("utf8")) fail("FAIL-TSJS-AST-REQUEST", "request header is not canonical JSON");
  exactRecord(header, ["analyzer_version", "files", "index_digest", "limits", "protocol", "request_id"], "header");
  if (header.protocol !== PROTOCOL_VERSION || header.analyzer_version !== ANALYZER_VERSION) fail("FAIL-TSJS-AST-REQUEST", "request protocol identity is invalid");
  boundedString(header.request_id, "request_id", { maximum: 128 });
  if (!/^sha256:[0-9a-f]{64}$/.test(header.index_digest ?? "")) fail("FAIL-TSJS-AST-REQUEST", "index_digest is invalid");
  exactRecord(header.limits, ["max_batch_bytes", "max_batch_files", "max_file_bytes"], "limits");
  safeInteger(header.limits.max_batch_files, "max_batch_files", 1);
  safeInteger(header.limits.max_batch_bytes, "max_batch_bytes", 1);
  safeInteger(header.limits.max_file_bytes, "max_file_bytes", 1);
  if (header.limits.max_batch_files > MAX_FILES || header.limits.max_batch_bytes > MAX_INPUT_BYTES || header.limits.max_file_bytes > MAX_INPUT_BYTES) {
    fail("FAIL-TSJS-AST-REQUEST", "request limits exceed helper hard bounds");
  }
  if (!Array.isArray(header.files) || header.files.length === 0 || header.files.length > header.limits.max_batch_files) {
    fail("FAIL-TSJS-AST-REQUEST", "files are invalid");
  }
  const files = [];
  let offset = 12 + headerLength;
  let total = 0;
  for (let ordinal = 0; ordinal < header.files.length; ordinal += 1) {
    const fact = header.files[ordinal];
    exactRecord(fact, ["blob_oid", "byte_length", "content_key", "ordinal", "sha256", "syntax"], `files[${ordinal}]`);
    if (fact.ordinal !== ordinal) fail("FAIL-TSJS-AST-REQUEST", "ordinals must be contiguous");
    if (!SUPPORTED_SYNTAX.includes(fact.syntax)) fail("FAIL-TSJS-AST-REQUEST", "syntax is invalid");
    safeInteger(fact.byte_length, `files[${ordinal}].byte_length`);
    if (fact.byte_length > header.limits.max_file_bytes || offset + fact.byte_length > frame.length) {
      fail("FAIL-TSJS-AST-REQUEST", `files[${ordinal}] bytes are truncated or over limit`);
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fact.blob_oid ?? "")) fail("FAIL-TSJS-AST-REQUEST", "blob_oid is invalid");
    const algorithm = fact.blob_oid.length === 40 ? "sha1" : "sha256";
    if (fact.content_key !== `git-blob:${algorithm}:${fact.blob_oid}` || !/^[0-9a-f]{64}$/.test(fact.sha256 ?? "")) {
      fail("FAIL-TSJS-AST-REQUEST", "content identity is invalid");
    }
    const bytes = Buffer.from(frame.subarray(offset, offset + fact.byte_length));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== fact.sha256) fail("FAIL-TSJS-AST-REQUEST", "source sha256 mismatch");
    total += bytes.length;
    if (total > header.limits.max_batch_bytes) fail("FAIL-TSJS-AST-REQUEST", "batch bytes exceed limit");
    files.push({ ...fact, bytes });
    offset += bytes.length;
  }
  if (offset !== frame.length) fail("FAIL-TSJS-AST-REQUEST", "request has trailing bytes");
  return { header, files };
}

function location(sourceFile, node) {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    col_offset: startPosition.character,
    end_col_offset: endPosition.character,
    end_lineno: endPosition.line + 1,
    lineno: startPosition.line + 1,
  };
}

function errorLocation(sourceFile, start, length) {
  if (!Number.isSafeInteger(start) || start < 0) return { col_offset: null, end_col_offset: null, end_lineno: null, lineno: null };
  const boundedStart = Math.min(start, sourceFile.text.length);
  const boundedEnd = Math.min(sourceFile.text.length, boundedStart + (Number.isSafeInteger(length) && length > 0 ? length : 0));
  const left = sourceFile.getLineAndCharacterOfPosition(boundedStart);
  const right = sourceFile.getLineAndCharacterOfPosition(boundedEnd);
  return { col_offset: left.character, end_col_offset: right.character, end_lineno: right.line + 1, lineno: left.line + 1 };
}

function errorFact(code, message, positions = {}) {
  const singleLine = String(message).replace(/[\r\n]+/g, " ").slice(0, 512) || "analysis unavailable";
  return {
    code,
    col_offset: positions.col_offset ?? null,
    end_col_offset: positions.end_col_offset ?? null,
    end_lineno: positions.end_lineno ?? null,
    lineno: positions.lineno ?? null,
    message: singleLine,
  };
}

function modifier(node, kind) {
  return Array.isArray(node.modifiers) && node.modifiers.some((item) => item.kind === kind);
}

function propertyName(ts, name, sourceFile) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier?.(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return `<computed@${location(sourceFile, name).lineno}:${location(sourceFile, name).col_offset}>`;
}

function className(ts, node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return propertyName(ts, current.name, sourceFile) ?? `<anonymous-class@${location(sourceFile, current).lineno}:${location(sourceFile, current).col_offset}>`;
    }
    current = current.parent;
  }
  return null;
}

function inferredName(ts, node, sourceFile) {
  if (node.name) return propertyName(ts, node.name, sourceFile);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return propertyName(ts, parent.name, sourceFile);
  if (parent && ts.isPropertyAssignment(parent)) return propertyName(ts, parent.name, sourceFile);
  if (parent && ts.isBinaryExpression(parent)) {
    const left = parent.left;
    if (ts.isPropertyAccessExpression(left)) return left.name.text;
    if (ts.isElementAccessExpression(left) && left.argumentExpression && ts.isStringLiteralLike(left.argumentExpression)) return left.argumentExpression.text;
  }
  const where = location(sourceFile, node);
  return `<anonymous@${where.lineno}:${where.col_offset}>`;
}

function callableKind(ts, node, nested) {
  const async = modifier(node, ts.SyntaxKind.AsyncKeyword);
  const generator = Boolean(node.asteriskToken);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isMethodDeclaration(node)) {
    if (async && generator) return "async-generator-method";
    if (generator) return "generator-method";
    return async ? "async-method" : "method";
  }
  if (ts.isArrowFunction(node)) return async ? "async-arrow-function" : "arrow-function";
  if (ts.isFunctionExpression(node)) {
    if (async && generator) return nested ? "nested-async-generator-function-expression" : "async-generator-function-expression";
    if (generator) return nested ? "nested-generator-function-expression" : "generator-function-expression";
    if (async) return nested ? "nested-async-function-expression" : "async-function-expression";
    return nested ? "nested-function-expression" : "function-expression";
  }
  if (async && generator) return nested ? "nested-async-generator-function" : "async-generator-function";
  if (generator) return nested ? "nested-generator-function" : "generator-function";
  if (async) return nested ? "nested-async-function" : "async-function";
  return nested ? "nested-function" : "function";
}

function isLogicalOperator(ts, kind) {
  return [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ].includes(kind);
}

function isLogicalAssignment(ts, kind) {
  return [
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(kind);
}

function logicalSequence(ts, node) {
  const operators = [];
  const visit = (value) => {
    if (ts.isBinaryExpression(value) && isLogicalOperator(ts, value.operatorToken.kind)) {
      visit(value.left);
      operators.push(value.operatorToken.kind);
      visit(value.right);
    }
  };
  visit(node);
  if (operators.length === 0) return 0;
  let increments = 1;
  for (let index = 1; index < operators.length; index += 1) {
    if (operators[index] !== operators[index - 1]) increments += 1;
  }
  return increments;
}

function directCallableName(ts, node, sourceFile) {
  const inferred = inferredName(ts, node, sourceFile);
  return inferred.startsWith("<") ? null : inferred;
}

function complexityForCallable(ts, callable, sourceFile) {
  let cyclomatic = 1;
  let cognitive = 0;
  const root = callable.body;
  const localName = directCallableName(ts, callable, sourceFile);

  const cyclomaticVisit = (node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
        || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCatchClause(node)
        || ts.isConditionalExpression(node) || ts.isCaseClause(node)) cyclomatic += 1;
    if (ts.isBinaryExpression(node) && (isLogicalOperator(ts, node.operatorToken.kind) || isLogicalAssignment(ts, node.operatorToken.kind))) cyclomatic += 1;
    ts.forEachChild(node, cyclomaticVisit);
  };

  const cognitiveVisit = (node, nesting, parentLogical = false, elseIf = false) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && isLogicalOperator(ts, node.operatorToken.kind) && !parentLogical) {
      cognitive += logicalSequence(ts, node);
    } else if (ts.isBinaryExpression(node) && isLogicalAssignment(ts, node.operatorToken.kind)) {
      cognitive += 1;
    }
    if (ts.isCallExpression(node) && localName) {
      const expression = node.expression;
      if ((ts.isIdentifier(expression) && expression.text === localName)
          || (ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword && expression.name.text === localName)) {
        cognitive += 1;
      }
    }
    if (ts.isIfStatement(node)) {
      cognitive += 1 + (elseIf ? 0 : nesting);
      cognitiveVisit(node.expression, nesting);
      cognitiveVisit(node.thenStatement, nesting + 1);
      if (node.elseStatement) {
        if (ts.isIfStatement(node.elseStatement)) cognitiveVisit(node.elseStatement, nesting, false, true);
        else {
          cognitive += 1;
          cognitiveVisit(node.elseStatement, nesting + 1);
        }
      }
      return;
    }
    if (ts.isForStatement(node)) {
      cognitive += 1 + nesting;
      if (node.initializer) cognitiveVisit(node.initializer, nesting);
      if (node.condition) cognitiveVisit(node.condition, nesting);
      if (node.incrementor) cognitiveVisit(node.incrementor, nesting);
      cognitiveVisit(node.statement, nesting + 1);
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      cognitive += 1 + nesting;
      cognitiveVisit(node.initializer, nesting);
      cognitiveVisit(node.expression, nesting);
      cognitiveVisit(node.statement, nesting + 1);
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      cognitive += 1 + nesting;
      cognitiveVisit(node.expression, nesting);
      cognitiveVisit(node.statement, nesting + 1);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      cognitive += 1 + nesting;
      cognitiveVisit(node.expression, nesting);
      for (const clause of node.caseBlock.clauses) {
        if (clause.expression) cognitiveVisit(clause.expression, nesting + 1);
        for (const statement of clause.statements) cognitiveVisit(statement, nesting + 1);
      }
      return;
    }
    if (ts.isCatchClause(node)) {
      cognitive += 1 + nesting;
      cognitiveVisit(node.block, nesting + 1);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      cognitive += 1 + nesting;
      cognitiveVisit(node.condition, nesting);
      cognitiveVisit(node.whenTrue, nesting + 1);
      cognitiveVisit(node.whenFalse, nesting + 1);
      return;
    }
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) cognitive += 1;
    ts.forEachChild(node, (child) => cognitiveVisit(
      child,
      nesting,
      ts.isBinaryExpression(node) && isLogicalOperator(ts, node.operatorToken.kind),
    ));
  };

  cyclomaticVisit(root);
  cognitiveVisit(root, 0);
  return { cognitive_complexity: cognitive, cyclomatic_complexity: cyclomatic };
}

function callableFacts(ts, sourceFile) {
  const facts = [];
  const walk = (node, callableStack) => {
    if (ts.isFunctionLike(node) && node.body) {
      const nested = callableStack.length > 0;
      const local = inferredName(ts, node, sourceFile);
      const owner = (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) ? className(ts, node, sourceFile) : null;
      const base = owner ? `${owner}.${local}` : local;
      const qualified = nested ? `${callableStack[callableStack.length - 1]}.<locals>.${base}` : base;
      facts.push({
        ...location(sourceFile, node),
        ...complexityForCallable(ts, node, sourceFile),
        kind: callableKind(ts, node, nested),
        qualified_name: qualified,
      });
      ts.forEachChild(node, (child) => walk(child, [...callableStack, qualified]));
      return;
    }
    ts.forEachChild(node, (child) => walk(child, callableStack));
  };
  walk(sourceFile, []);
  facts.sort((left, right) => left.lineno - right.lineno || left.col_offset - right.col_offset
    || left.end_lineno - right.end_lineno || left.end_col_offset - right.end_col_offset
    || stableCompare(left.qualified_name, right.qualified_name));
  if (facts.length > MAX_FACTS_PER_FILE) fail("FAIL-TSJS-AST-FACT-LIMIT", "callable facts exceed hard limit");
  return facts;
}

function importNames(ts, clause) {
  if (!clause) return [];
  const names = [];
  if (clause.name) names.push({ imported: "default", local: clause.name.text });
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push({ imported: "*", local: bindings.name.text });
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push({
      imported: element.propertyName?.text ?? element.name.text,
      local: element.name.text,
    });
  }
  return names.sort((left, right) => stableCompare(left.imported, right.imported) || stableCompare(left.local, right.local));
}

function dependencyFact(sourceFile, node, kind, moduleName, names = [], typeOnly = false) {
  return {
    ...location(sourceFile, node),
    kind,
    module: moduleName,
    names,
    type_only: Boolean(typeOnly),
  };
}

function exportFact(sourceFile, node, kind, name, localName, moduleName, typeOnly) {
  return {
    ...location(sourceFile, node),
    kind,
    local_name: localName,
    module: moduleName,
    name,
    type_only: Boolean(typeOnly),
  };
}

function commonJsAssignment(ts, node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const left = node.left;
  if (ts.isPropertyAccessExpression(left)) {
    if (ts.isIdentifier(left.expression) && left.expression.text === "exports") return { kind: "commonjs-property", name: left.name.text };
    if (ts.isPropertyAccessExpression(left.expression)
        && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === "module"
        && left.expression.name.text === "exports") return { kind: "commonjs-property", name: left.name.text };
    if (ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports") return { kind: "commonjs-assignment", name: null };
  }
  return null;
}

function dependencyAndExportFacts(ts, sourceFile) {
  const dependencies = [];
  const exports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      dependencies.push(dependencyFact(sourceFile, node, "import", moduleName, importNames(ts, node.importClause), node.importClause?.isTypeOnly));
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteralLike(reference.expression)) {
        dependencies.push(dependencyFact(sourceFile, node, "import-equals-require", reference.expression.text, [{ imported: "=", local: node.name.text }], node.isTypeOnly));
      }
    } else if (ts.isExportDeclaration(node)) {
      const moduleName = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (moduleName) dependencies.push(dependencyFact(
        sourceFile,
        node,
        node.exportClause ? "export-from" : "export-all-from",
        moduleName,
        [],
        node.isTypeOnly,
      ));
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.push(exportFact(sourceFile, element, "named", element.name.text, element.propertyName?.text ?? element.name.text, moduleName, node.isTypeOnly || element.isTypeOnly));
        }
      } else if (!node.exportClause) {
        exports.push(exportFact(sourceFile, node, "export-all", null, null, moduleName, node.isTypeOnly));
      }
    } else if (ts.isExportAssignment(node)) {
      exports.push(exportFact(sourceFile, node, node.isExportEquals ? "export-equals" : "default", "default", null, null, false));
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dependencies.push(dependencyFact(sourceFile, node, first && ts.isStringLiteralLike(first) ? "dynamic-import-literal" : "dynamic-import-dynamic", first && ts.isStringLiteralLike(first) ? first.text : null));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        dependencies.push(dependencyFact(sourceFile, node, first && ts.isStringLiteralLike(first) ? "require-literal" : "require-dynamic", first && ts.isStringLiteralLike(first) ? first.text : null));
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const literal = ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal) ? argument.literal.text : null;
      dependencies.push(dependencyFact(sourceFile, node, literal === null ? "import-type-dynamic" : "import-type", literal, [], true));
    }

    const commonJs = commonJsAssignment(ts, node);
    if (commonJs) exports.push(exportFact(sourceFile, node, commonJs.kind, commonJs.name, null, null, false));

    const exported = modifier(node, ts.SyntaxKind.ExportKeyword);
    if (exported && !ts.isExportDeclaration(node) && !ts.isExportAssignment(node)) {
      const isDefault = modifier(node, ts.SyntaxKind.DefaultKeyword);
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          const name = propertyName(ts, declaration.name, sourceFile);
          exports.push(exportFact(sourceFile, declaration, isDefault ? "default" : "named", isDefault ? "default" : name, name, null, false));
        }
      } else if (node.name || isDefault) {
        const name = propertyName(ts, node.name, sourceFile);
        exports.push(exportFact(sourceFile, node, isDefault ? "default" : "named", isDefault ? "default" : name, name, null,
          ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const compare = (left, right) => left.lineno - right.lineno || left.col_offset - right.col_offset
    || left.end_lineno - right.end_lineno || left.end_col_offset - right.end_col_offset
    || stableCompare(left.kind, right.kind) || stableCompare(left.module ?? "", right.module ?? "")
    || stableCompare(left.name ?? "", right.name ?? "");
  dependencies.sort(compare);
  exports.sort(compare);
  if (dependencies.length > MAX_FACTS_PER_FILE || exports.length > MAX_FACTS_PER_FILE) fail("FAIL-TSJS-AST-FACT-LIMIT", "dependency/export facts exceed hard limit");
  return { dependencies, exports };
}

function unsupportedSyntax(ts, sourceFile) {
  let unsupported = null;
  const visit = (node) => {
    if (unsupported) return;
    if (ts.isWithStatement(node)) {
      unsupported = { node, reason: "with-statement-dynamic-scope" };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return unsupported;
}

function scriptKind(ts, syntax) {
  return {
    javascript: ts.ScriptKind.JS,
    jsx: ts.ScriptKind.JSX,
    typescript: ts.ScriptKind.TS,
    tsx: ts.ScriptKind.TSX,
  }[syntax];
}

function analyzeFile(ts, file) {
  let sourceText;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return { status: "unavailable", error: errorFact("FAIL-TSJS-AST-DECODE", "source is not valid UTF-8") };
  }
  if (sourceText.includes("\0")) return { status: "unavailable", error: errorFact("FAIL-TSJS-AST-DECODE", "source contains NUL") };
  const sourceFile = ts.createSourceFile(
    `<sei-blob:${file.ordinal}>.${file.syntax}`,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, file.syntax),
  );
  const diagnostic = sourceFile.parseDiagnostics?.[0];
  if (diagnostic) {
    return {
      status: "unavailable",
      error: errorFact(
        "FAIL-TSJS-AST-PARSE",
        `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        errorLocation(sourceFile, diagnostic.start, diagnostic.length),
      ),
    };
  }
  const unsupported = unsupportedSyntax(ts, sourceFile);
  if (unsupported) {
    return {
      status: "unavailable",
      error: errorFact("FAIL-TSJS-AST-UNSUPPORTED-SYNTAX", unsupported.reason, location(sourceFile, unsupported.node)),
    };
  }
  const { dependencies, exports } = dependencyAndExportFacts(ts, sourceFile);
  return { status: "ok", callables: callableFacts(ts, sourceFile), dependencies, exports };
}

function unavailableResult(file, code, message, positions = {}) {
  return {
    content_key: file.content_key,
    error: errorFact(code, message, positions),
    ordinal: file.ordinal,
    sha256: file.sha256,
    status: "unavailable",
    syntax: file.syntax,
  };
}

function analyze(runtimeState, request) {
  const results = request.files.map((file) => {
    if (!runtimeState.ts) return unavailableResult(file, "FAIL-TSJS-AST-PARSER-UNAVAILABLE", runtimeState.reason);
    try {
      const analyzed = analyzeFile(runtimeState.ts, file);
      if (analyzed.status !== "ok") return unavailableResult(file, analyzed.error.code, analyzed.error.message, analyzed.error);
      return {
        callables: analyzed.callables,
        content_key: file.content_key,
        dependencies: analyzed.dependencies,
        exports: analyzed.exports,
        ordinal: file.ordinal,
        sha256: file.sha256,
        status: "ok",
        syntax: file.syntax,
      };
    } catch (error) {
      return unavailableResult(file, error.code === "FAIL-TSJS-AST-FACT-LIMIT" ? error.code : "FAIL-TSJS-AST-ANALYSIS", error.message);
    }
  });
  const unavailable = results.filter((result) => result.status === "unavailable").length;
  return {
    analyzer_version: ANALYZER_VERSION,
    diagnostics: {
      files_received: results.length,
      files_succeeded: results.length - unavailable,
      files_unavailable: unavailable,
    },
    protocol: PROTOCOL_VERSION,
    request_id: request.header.request_id,
    results,
    runtime: runtimeState.runtime,
    status: unavailable === 0 ? "ok" : unavailable === results.length ? "unavailable" : "partial",
  };
}

function frameResponse(value) {
  const body = Buffer.from(canonicalJson(value), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([RESPONSE_MAGIC, length, body]);
}

async function main() {
  const mode = process.argv[2];
  const typescriptArgument = process.argv[3] || "";
  const runtimeState = loadRuntime(typescriptArgument);
  if (mode === "--probe") {
    process.stdout.write(canonicalJson(probe(runtimeState)));
    return;
  }
  if (mode !== "--analyze") fail("FAIL-TSJS-AST-USAGE", "expected --probe or --analyze");
  const request = decodeRequest(await readStdinBounded());
  process.stdout.write(frameResponse(analyze(runtimeState, request)));
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 1024));
  process.exitCode = 1;
});
