#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { resolveSeiLayout } = require(path.resolve(
  __dirname,
  "../../shared/software-engineering-intelligence/layout.js",
));
const { execute } = require(resolveSeiLayout({
  skillRoot: path.resolve(__dirname, ".."),
}).cli_path);

async function main() {
  try {
    const receipt = await execute(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`SEI_ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

void main();
