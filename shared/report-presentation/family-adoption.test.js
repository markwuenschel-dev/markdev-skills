"use strict";
const assert=require("node:assert/strict"); const fs=require("node:fs"); const path=require("node:path");
const skillsRoot=path.resolve(__dirname,"..","..");
const adopters=[
 ["repository-improvement-assessment","assets/report-scaffold.html","scripts/build-report.js"],
 ["repository-health-assessment","assets/report-scaffold.html","assets/build-report.js"],
 ["codebase-integrity-audit-loop","assets/report-scaffold.html","assets/build-report.js"],
 ["architecture-improvement-intelligence","assets/report-scaffold.html","assets/build-report.js"],
 ["software-engineering-intelligence","assets/report-template.html",path.join("..","shared","software-engineering-intelligence","report.js")],
];
for(const [skill,templateRel,builderRel] of adopters){
 const template=fs.readFileSync(path.join(skillsRoot,skill,templateRel),"utf8");
 const builder=builderRel.startsWith("..")?fs.readFileSync(path.resolve(skillsRoot,skill,builderRel),"utf8"):fs.readFileSync(path.join(skillsRoot,skill,builderRel),"utf8");
 assert.match(template,/data-report-responsive="1"/,`${skill}:responsive marker`);
 assert.ok(/3000px|12-column|grid-template-columns:\s*repeat\(12/i.test(template) || template.includes('class="rp-shell rp-grid"'),`${skill}:wide canvas`);
 assert.doesNotMatch(template,/main\s*\{[^}]*max-width:\s*(?:9|10|11|12)\d{2}px/i,`${skill}:narrow main`);
 assert.match(builder,/report-presentation/,`${skill}:shared presentation runtime`);
}
console.log("REPORT_PRESENTATION_FAMILY_ADOPTION_OK");
