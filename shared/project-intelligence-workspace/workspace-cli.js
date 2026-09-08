#!/usr/bin/env node
"use strict";
const W=require("./project-intelligence-workspace.js");
function usage(){console.log("usage: node workspace-cli.js init [repo] | path <repo> <category> [segments...] | report <repo> <owner> <filename> | cleanup-scratch [repo] | prune-cache [repo] [days] [--apply]");}
const [, , command, ...args]=process.argv;
try {
  if(!command || command==='--help' || command==='-h'){usage();process.exitCode=command?0:2;}
  else if(command==='init'){
    const value=W.ensureWorkspace(args[0]||process.cwd());
    console.log(JSON.stringify({schema_version:W.SCHEMA_VERSION,repository_root:value.repository_root,workspace_root:value.workspace_root,paths:value.paths,git_exclude:value.git_exclude},null,2));
  } else if(command==='path'){
    if(args.length<2) throw new Error('path requires <repo> <category> [segments...]');
    console.log(W.resolvePath(args[0],args[1],...args.slice(2)));
  } else if(command==='report'){
    if(args.length!==3) throw new Error('report requires <repo> <owner> <filename>');
    console.log(W.reportPath(args[0],args[1],args[2]));
  } else if(command==='cleanup-scratch') console.log(W.cleanupScratch(args[0]||process.cwd()));
  else if(command==='prune-cache') {
    const applyIndex=args.indexOf('--apply'); const filtered=args.filter(x=>x!=='--apply');
    const repo=filtered[0]||process.cwd(); const days=filtered[1]===undefined?30:Number(filtered[1]);
    console.log(JSON.stringify(W.pruneReclaimable(repo,{olderThanDays:days,dryRun:applyIndex<0}),null,2));
  } else throw new Error('unknown command: '+command);
} catch(error){console.error(error.message||error);process.exitCode=1;}
