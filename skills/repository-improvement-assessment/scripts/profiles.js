"use strict";

const DEPTHS = new Set(["quick", "standard", "deep", "custom"]);
const BASE = Object.freeze({
  quick: Object.freeze({ max_wall_minutes: 10, max_subagent_tokens: 30_000, max_tool_calls: 80, max_owner_candidates: 8, max_parallel_agents: 2, max_heavy_tools: 2, optional_tools: false, evidence_budget: "bounded" }),
  standard: Object.freeze({ max_wall_minutes: 30, max_subagent_tokens: 90_000, max_tool_calls: 240, max_owner_candidates: 24, max_parallel_agents: 3, max_heavy_tools: 2, optional_tools: true, evidence_budget: "standard" }),
  deep: Object.freeze({ max_wall_minutes: 90, max_subagent_tokens: 240_000, max_tool_calls: 640, max_owner_candidates: 64, max_parallel_agents: 3, max_heavy_tools: 3, optional_tools: true, evidence_budget: "deep" }),
});
const NUMERIC = ["max_wall_minutes", "max_subagent_tokens", "max_tool_calls", "max_owner_candidates", "max_parallel_agents", "max_heavy_tools"];

function profile(depth = "standard", custom = {}) {
  if (!DEPTHS.has(depth)) throw new Error(`FAIL-RIA-PROFILE: unsupported depth ${depth}`);
  if (depth !== "custom") return Object.freeze({ depth, ...BASE[depth] });
  if (!custom || typeof custom !== "object" || Object.keys(custom).some((key) => !NUMERIC.includes(key))) throw new Error("FAIL-RIA-PROFILE: custom budget contains unsupported fields");
  const values = {};
  for (const key of NUMERIC) {
    const value = Number(custom[key]);
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) throw new Error(`FAIL-RIA-PROFILE: ${key} must be a positive integer`);
    values[key] = value;
  }
  return Object.freeze({ depth, ...values, optional_tools: true, evidence_budget: "custom" });
}

module.exports = { BASE, DEPTHS, profile };
