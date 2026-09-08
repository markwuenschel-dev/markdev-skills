"use strict";
const assert = require("node:assert/strict");
const p = require("./report-presentation.js");

const bars = p.horizontalBarChart({ id:"scores", title:"Scores", description:"Example score comparison", items:[{label:"Health",value:58},{label:"Coverage",value:71.2},{label:"Missing",value:null}], max:100 });
assert.match(bars, /data-rp-chart="scores"/);
assert.match(bars, /Not scored/);
const donut = p.donutChart({ id:"routes", title:"Routes", description:"Route distribution", items:[{label:"Ready",value:4},{label:"Blocked",value:1}] });
assert.match(donut, />5</);
const html = `<!doctype html><html data-report-responsive="1"><head><meta name="viewport" content="width=device-width"><style>${p.responsiveCss()}</style></head><body><main class="rp-shell">${bars}</main></body></html>`;
assert.deepEqual(p.inspectResponsiveReport(html, { requireVisualization:true }), { ok:true, problems:[] });
assert.equal(p.assertNoViewTimeNetwork('<script src="https://x.invalid/a.js"></script>').ok, false);
assert.match(p.progressiveScript(), /reportDensity/);
console.log("REPORT_PRESENTATION_TEST_OK");
