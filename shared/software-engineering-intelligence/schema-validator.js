"use strict";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function canonicalKey(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalKey(value[key])}`).join(",")}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function matchesType(value, type) {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return isRecord(value);
    case "string": return typeof value === "string";
    default: return false;
  }
}

function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`FAIL-SCHEMA-CONTRACT: unsupported schema reference ${String(ref)}`);
  }
  return ref.slice(2).split("/").reduce((value, segment) => value?.[segment], root);
}

function validateNode(value, node, root, path) {
  const errors = [];
  const schema = node.$ref ? resolveRef(root, node.$ref) : node;
  if (!schema) return [`${path}: unresolved schema reference`];

  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    errors.push(`${path}: must equal the schema constant`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push(`${path}: must be one of the declared values`);
  }
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((type) => matchesType(value, type))) {
      errors.push(`${path}: must have the declared type`);
      return errors;
    }
  }
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}: must meet minLength`);
  }
  if (typeof schema.pattern === "string" && typeof value === "string" && !(new RegExp(schema.pattern).test(value))) {
    errors.push(`${path}: must match the declared pattern`);
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: must meet minimum`);
  }
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path}: must meet maximum`);
  }
  if (typeof schema.minItems === "number" && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${path}: must meet minItems`);
  }
  if (schema.uniqueItems === true && Array.isArray(value)) {
    const firstIndexByKey = new Map();
    for (let index = 0; index < value.length; index += 1) {
      const key = canonicalKey(value[index]);
      const firstIndex = firstIndexByKey.get(key);
      if (firstIndex !== undefined && deepEqual(value[index], value[firstIndex])) {
        errors.push(`${path}[${index}]: duplicates ${path}[${firstIndex}]`);
      } else if (firstIndex === undefined) {
        firstIndexByKey.set(key, index);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateNode(item, schema.items, root, `${path}[${index}]`)));
  }
  if (isRecord(value)) {
    for (const field of schema.required ?? []) {
      if (!(field in value)) errors.push(`${path}.${field}: is required`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      Object.keys(value).forEach((field) => {
        if (!Object.hasOwn(properties, field)) errors.push(`${path}.${field}: is not declared`);
      });
    }
    Object.entries(properties).forEach(([field, propertySchema]) => {
      if (field in value) errors.push(...validateNode(value[field], propertySchema, root, `${path}.${field}`));
    });
  }
  for (const allOfNode of schema.allOf ?? []) {
    errors.push(...validateNode(value, allOfNode, root, path));
  }
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((alternative) => validateNode(value, alternative, root, path).length === 0);
    if (!valid) errors.push(`${path}: must satisfy at least one declared alternative`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((alternative) => validateNode(value, alternative, root, path).length === 0).length;
    if (matches !== 1) errors.push(`${path}: must satisfy exactly one declared alternative`);
  }
  if (schema.if) {
    const conditionMatches = validateNode(value, schema.if, root, path).length === 0;
    const branch = conditionMatches ? schema.then : schema.else;
    if (branch) errors.push(...validateNode(value, branch, root, path));
  }
  if (schema.not && validateNode(value, schema.not, root, path).length === 0) {
    errors.push(`${path}: must not satisfy the excluded schema`);
  }
  return errors;
}

function validateAgainstSchema(value, schema) {
  return validateNode(value, schema, schema, "$");
}

module.exports = { validateAgainstSchema };
