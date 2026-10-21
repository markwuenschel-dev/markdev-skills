/* mermaid-safe.js — data-driven, sanitized Mermaid rendering for the
 * architecture review report (improve-codebase-architecture-mwdev).
 *
 * Why this exists: candidate names come from real codebases and contain
 * slashes, parens, colons, arrows (`->`, `→`), brackets, quotes, `#`,
 * backticks, backslashes, markdown, emoji, and reserved words like `end`.
 * Hand-written Mermaid source turns any one of those into a syntax error that
 * replaces the whole page with a red splash. These helpers make that
 * impossible by construction:
 *
 *   - node ids are synthetic (`n0`, `n1`, …) — never derived from names
 *   - every label is escaped and quoted            (escapeLabel)
 *   - diagrams are declared as {direction, nodes, edges} data (buildFlowchart)
 *   - rendering is validated (mermaid.parse) and isolated per diagram, with a
 *     readable text fallback                       (renderInto / renderAllGraphs)
 *
 * This file is deliberately export-free (a classic script):
 *   - the report inlines the body verbatim into its <script type="module">
 *     (the report lives in $TMPDIR and cannot reference this file at view time);
 *   - the regression fixture (mermaid-safe.test.html) loads it with a plain
 *     <script src="./mermaid-safe.js"> so it works when opened from file://
 *     (browsers block *module* imports from file://, but allow classic scripts).
 * The functions are also attached to globalThis.MermaidSafe so both consumers
 * see one API: { escapeLabel, nodeId, buildFlowchart, renderInto, renderAllGraphs }.
 */

"use strict";

/** Max label length in code points before truncation with an ellipsis. */
const MERMAID_SAFE_MAX_LABEL = 60;

/* Reserved-role styling, baked as literal hexes so classDef always parses.
 * `--critical` (#d03b3b) is theme-invariant by design; the deep fill matches
 * the light `--deep-fill` and stays legible on both surfaces. A report may
 * refine per-theme via CSS, e.g.:
 *   [data-graph] .deep rect { fill: var(--deep-fill) !important; }
 */
const MERMAID_SAFE_CLASSDEFS = {
  deep: "classDef deep fill:#2c2c2a,stroke:#0b0b0b,stroke-width:2px,color:#ffffff",
  leak: "classDef leak stroke:#d03b3b,stroke-width:2px",
};

let mermaidSafeUid = 0;

/**
 * Escape a human name into a Mermaid-safe quoted-label payload.
 * Collapses whitespace, truncates overlong names (code-point safe, so emoji
 * never split into lone surrogates), and replaces the characters Mermaid
 * chokes on with Mermaid entity codes. The result is meant to be wrapped in
 * quotes by the builder — inside a quoted label, slashes, parentheses,
 * colons, arrows, brackets, pipes, semicolons, and markdown all pass through
 * safely; the entity codes cover the six characters that are unsafe even
 * inside quotes.
 */
function escapeLabel(name) {
  let s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!s) return "(unnamed)";
  const points = Array.from(s); // code points, not UTF-16 units
  if (points.length > MERMAID_SAFE_MAX_LABEL) {
    s = points.slice(0, MERMAID_SAFE_MAX_LABEL - 1).join("").trimEnd() + "…";
  }
  // `#` must be escaped FIRST: every other escape *introduces* `#`, so
  // escaping `#` later would corrupt them (e.g. `#quot;` → `#35;quot;`).
  return s
    .replace(/#/g, "#35;")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    // A raw backtick makes Mermaid v11 treat the label as a *markdown string*
    // and reject it — this escape is load-bearing, not cosmetic.
    .replace(/`/g, "#96;");
}

/** Synthetic node id — names never touch identifiers, so a name can never
 * produce an invalid id, an id collision, or the reserved word `end`. */
function nodeId(i) {
  return "n" + i;
}

/* internal: identity is never colour-alone — make sure the role word rides
 * the label unless the name already carries it. */
function mermaidSafeWithRoleWord(label, role) {
  return new RegExp("\\b" + role + "\\b", "i").test(label)
    ? label
    : label + " · " + role;
}

/**
 * Build flowchart source from data: { direction, nodes, edges }.
 *   direction    "LR" (default) | "RL" | "TD" | "TB" | "BT" — anything else → "LR"
 *   nodes[i]     { name, role?: "deep"|"leak", shape?: "round"|"stadium" }
 *   edges[j]     { from, to, label?, kind?: "solid"|"dotted"|"thick", role?: "leak" }
 * Edges referencing a missing or non-integer index are dropped — never
 * emitted as broken source. Leak edges are force-labelled "leak" (the
 * non-colour channel is not optional) and get the critical linkStyle.
 */
function buildFlowchart(graph) {
  const g = graph && typeof graph === "object" ? graph : {};
  const DIRECTIONS = ["LR", "RL", "TD", "TB", "BT"];
  const dirRaw = String(g.direction || "").toUpperCase();
  const direction = DIRECTIONS.indexOf(dirRaw) >= 0 ? dirRaw : "LR";
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];

  const lines = ["flowchart " + direction];
  const rolesUsed = new Set();

  nodes.forEach((node, i) => {
    const id = nodeId(i);
    let label = escapeLabel(node && node.name);
    const role =
      node && (node.role === "deep" || node.role === "leak") ? node.role : null;
    if (role) {
      label = mermaidSafeWithRoleWord(label, role);
      rolesUsed.add(role);
    }
    let open = '["';
    let close = '"]';
    if (node && node.shape === "round") { open = '("'; close = '")'; }
    else if (node && node.shape === "stadium") { open = '(["'; close = '"])'; }
    lines.push("  " + id + open + label + close);
    if (role) lines.push("  class " + id + " " + role);
  });

  const linkStyles = [];
  let linkIndex = 0; // linkStyle indexes count emitted edges only
  edges.forEach((edge) => {
    if (!edge) return;
    const from = edge.from;
    const to = edge.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length) return;

    let label =
      edge.label == null || String(edge.label).trim() === ""
        ? null
        : escapeLabel(edge.label);
    if (edge.role === "leak") {
      label = label ? mermaidSafeWithRoleWord(label, "leak") : "leak";
      linkStyles.push(
        "  linkStyle " + linkIndex + " stroke:#d03b3b,stroke-width:2px"
      );
    }

    let arrow;
    if (edge.kind === "dotted") arrow = label ? '-. "' + label + '" .->' : "-.->";
    else if (edge.kind === "thick") arrow = label ? '== "' + label + '" ==>' : "==>";
    else arrow = label ? '-- "' + label + '" -->' : "-->";

    lines.push("  " + nodeId(from) + " " + arrow + " " + nodeId(to));
    linkIndex++;
  });

  rolesUsed.forEach((role) => lines.push("  " + MERMAID_SAFE_CLASSDEFS[role]));
  lines.push(...linkStyles);
  return lines.join("\n");
}

/* internal: readable text fallback — the graceful-degradation path. Names go
 * in via textContent (data, never markup), so a hostile name can't inject. */
function mermaidSafeFallback(el, graph, reason, source) {
  const lines = [];
  if (graph && typeof graph === "object" && Array.isArray(graph.nodes)) {
    const nodes = graph.nodes;
    const plain = (i) => {
      const n = nodes[i];
      const s =
        n && n.name != null ? String(n.name).replace(/\s+/g, " ").trim() : "";
      return s || "node " + i;
    };
    const inEdge = new Set();
    (Array.isArray(graph.edges) ? graph.edges : []).forEach((e) => {
      if (!e || !Number.isInteger(e.from) || !Number.isInteger(e.to)) return;
      if (e.from < 0 || e.from >= nodes.length || e.to < 0 || e.to >= nodes.length) return;
      inEdge.add(e.from);
      inEdge.add(e.to);
      const lab =
        e.label != null && String(e.label).trim() !== ""
          ? "  (" + String(e.label).replace(/\s+/g, " ").trim() + ")"
          : "";
      lines.push(plain(e.from) + " → " + plain(e.to) + lab);
    });
    nodes.forEach((n, i) => {
      if (!inEdge.has(i)) lines.push(plain(i));
    });
  }
  if (lines.length === 0) lines.push("(diagram unavailable)");

  el.textContent = "";
  const box = document.createElement("div");
  box.className = "mermaid-fallback";
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "Diagram fallback: " + lines.join("; "));
  box.style.cssText =
    "border:1px dashed var(--baseline,#c3c2b7);border-radius:8px;padding:12px;" +
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;" +
    "color:var(--ink-secondary,#52514e);";

  const head = document.createElement("div");
  head.className = "mermaid-fallback-title";
  head.textContent = "diagram unavailable — text fallback";
  head.style.cssText =
    "text-transform:uppercase;letter-spacing:.08em;font-size:10px;" +
    "color:var(--ink-muted,#898781);margin-bottom:6px;";

  const pre = document.createElement("pre");
  pre.textContent = lines.join("\n");
  pre.style.cssText = "margin:0;white-space:pre-wrap;";

  box.appendChild(head);
  box.appendChild(pre);
  el.appendChild(box);
  return { ok: false, mode: "fallback", reason: reason || "", source: source || "", el };
}

/**
 * Render one graph (the {direction, nodes, edges} data) into `el` using the
 * given mermaid instance. Validates with mermaid.parse and renders inside a
 * try/catch; on any failure the container gets a readable `.mermaid-fallback`
 * instead — it never blanks the page or leaks a syntax error.
 * Resolves to { ok, mode: "svg"|"fallback", source, el, reason? }.
 */
async function renderInto(el, graph, mermaid) {
  let source = "";
  const id = "mermaid-safe-" + mermaidSafeUid++;
  try {
    source = buildFlowchart(graph);
    await mermaid.parse(source); // throws on invalid source
    const out = await mermaid.render(id, source);
    el.textContent = "";
    el.innerHTML = out.svg; // mermaid output from sanitized source
    if (typeof out.bindFunctions === "function") out.bindFunctions(el);
    el.classList.add("mermaid-rendered");
    return { ok: true, mode: "svg", source, el };
  } catch (error) {
    // A failed mermaid.render can leave a stray element behind — remove it.
    ["", "d"].forEach((prefix) => {
      const stray = document.getElementById(prefix + id);
      if (stray && !el.contains(stray)) stray.remove();
    });
    const reason = (error && error.message) || String(error);
    return mermaidSafeFallback(el, graph, reason, source);
  }
}

/**
 * Find every container matching `selector` (default "[data-graph]"), parse
 * its data-graph JSON, and render each one individually — one bad diagram
 * can never take the others (or the page) down. Malformed JSON degrades to
 * the same readable fallback. Resolves to an array of renderInto results.
 */
async function renderAllGraphs(selector, mermaid, root) {
  const scope = root || document;
  const containers = Array.from(
    scope.querySelectorAll(selector || "[data-graph]")
  );
  const results = [];
  for (const el of containers) {
    let graph = null;
    try {
      graph = JSON.parse(el.getAttribute("data-graph"));
    } catch (error) {
      results.push(
        mermaidSafeFallback(el, null, "invalid data-graph JSON: " + error.message, "")
      );
      continue;
    }
    results.push(await renderInto(el, graph, mermaid));
  }
  return results;
}

globalThis.MermaidSafe = {
  escapeLabel,
  nodeId,
  buildFlowchart,
  renderInto,
  renderAllGraphs,
};
