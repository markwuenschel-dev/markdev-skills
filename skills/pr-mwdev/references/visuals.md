# Summary visuals

Adapted from Dex Horthy's `show-me` skill (see `../CREDITS.md`). Pick the smallest view that makes the key point; one is the norm, two when the change has a structural and a behavioural side. Keep each under about 25 lines and only the calls, files, props, states, and boundaries a reviewer needs.

| Point to make | View |
| --- | --- |
| Logic or an algorithm | pseudocode |
| Runtime control flow | call tree |
| UI structure, with state and module boundaries | component tree, paths in parentheses |
| File responsibility or a broad refactor | shallow file tree with `# role` comments |
| Interaction or data flow between parts | Mermaid `sequenceDiagram` / `flowchart` (GitHub renders it) |
| What changed inside a shape that already exists | `diff` of any view above |
| Mostly new code, or a copyable target shape | the whole block |

A `diff` keeps the shape of the view it modifies:

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
-  navigateToSession
+  navigateToSession
+    subscribeToEvents
```

```diff
 src/
 ├── commands/
+│   └── show-me.ts       # expands the slash command
-└── transport.ts
+└── transport/
+    ├── client.ts
+    └── stream.ts
```
