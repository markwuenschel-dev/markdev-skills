"use strict";
const fs=require("node:fs"),path=require("node:path"),child=require("node:child_process");
const root=path.resolve(__dirname,"..");
for(const relative of ["scripts/report-model.js","scripts/build-report-data.js","scripts/build-report.js","scripts/report-v3.test.js","assets/report-scaffold.html","assets/html-report-input.schema.json"]){if(!fs.existsSync(path.join(root,relative)))throw new Error("MISSING:"+relative);}
child.execFileSync(process.execPath,[path.join(root,"scripts","report-v3.test.js")],{stdio:"inherit"});
console.log("RIA_REPORT_V3_PACKAGE_OK");
