---
name: wayfinder-mwdev
description: Legacy compatibility alias for decision-terrain-mapper. Use only when an existing saved workflow explicitly references wayfinder-mwdev; new decision-terrain work routes to decision-terrain-mapper.
disable-model-invocation: true
---

# Legacy compatibility alias

This package no longer owns a decision-mapping protocol.

Forward the complete map reference, destination, scope, decision-owner context, fog, open questions, and any legacy Wayfinder state to `/decision-terrain-mapper`, then follow that skill. Decision Terrain Mapper v3 resumes legacy `wayfinder:*`, `.wayfinder/`, and `kind: wayfinder-map` state in place; do not bulk-migrate live map state merely for the rename.

Do not maintain an independent planning, grilling, tracker, or lifecycle loop here.
