#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const plannerDir = path.resolve(__dirname, '..');
const skillsDir = path.resolve(plannerDir, '..');
const flywheelDir = path.join(skillsDir, 'production-flywheel');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const planner = read(path.join(plannerDir, 'SKILL.md'));
const types = read(path.join(plannerDir, 'SWARM-TYPES.md'));
const autoMode = read(path.join(plannerDir, 'AUTO-MODE.md'));
const topology = read(path.join(plannerDir, 'assets', 'execution-topology.yaml'));
const flywheel = read(path.join(flywheelDir, 'SKILL.md'));
const manual = read(path.join(flywheelDir, 'references', 'manual-delivery.md'));
const d7 = read(path.join(flywheelDir, 'ACTION-GRAPH-MODE.md'));

const checks = [
  [planner.includes('production-flywheel` owns **all mutating production delivery**'), 'planner must name Flywheel as mutating owner'],
  [planner.includes('Execution-topology handoff mode'), 'planner must expose topology handoff mode'],
  [!planner.includes('**Implementation mode**'), 'planner must not retain direct Implementation mode'],
  [types.includes('## Production execution topology'), 'production swarm must be topology, not implementation owner'],
  [types.includes('This is **not** an alternative to `production-flywheel`'), 'types must preserve Flywheel execution authority'],
  [autoMode.includes('may **not** create worktrees, edit repository files, commit, push, open PRs'), 'auto mode must prohibit direct mutation'],
  [topology.includes('execution_owner: production-flywheel'), 'topology must bind Flywheel execution owner'],
  [topology.includes('mutation_permitted_in_planner: false'), 'topology must mechanically state planner mutation false'],
  [flywheel.includes('canonical mutating delivery owner'), 'Flywheel must state canonical mutation ownership'],
  [flywheel.includes('human-directed-swarm-planner` owns **execution topology**'), 'Flywheel must recognize planner topology ownership'],
  [manual.includes('execution-topology handoff mode'), 'manual delivery must request planner topology for parallel work'],
  [manual.includes('Flywheel executes the selected topology'), 'manual delivery must keep execution in Flywheel'],
  [d7.includes('Planner/Flywheel boundary'), 'D7 must pin cross-action concurrency authority'],
  [d7.includes('cannot change the frontier, batch membership'), 'planner must not override D7 batch'],
  [types.includes('adaptive-causal-debugging'), 'bug topology must route to adaptive causal debugger']
];

let passed = 0;
for (const [ok, msg] of checks) {
  assert(ok, msg);
  passed++;
}
console.log(`GREEN ${passed}/${checks.length} planner/flywheel ownership checks`);
