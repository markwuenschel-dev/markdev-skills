"use strict";

const { junit } = require("node:test/reporters");

module.exports = async function* junitTestsuiteReporter(source) {
  let output = "";
  for await (const chunk of junit(source)) output += chunk;
  const declaration = output.match(/^<\?xml[^>]*>\s*/)?.[0] ?? "";
  const body = output.slice(declaration.length)
    .replace(/^<testsuites>\s*/, "")
    .replace(/\s*<\/testsuites>\s*$/, "");
  yield `${declaration}<testsuites><testsuite name="node:test">\n${body}\n</testsuite></testsuites>\n`;
};
