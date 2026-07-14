# Lens detail

Loaded from SKILL.md Stage 4 when a lens with detailed guidance is selected. Currently only the Wiring & Integration lens is elaborated; the other lenses run on their one-line definitions in SKILL.md.

## Wiring & Integration Lens

Use when the selected candidate involves missing, broken, duplicated, stale, or unclear connections between components, modules, layers, services, or languages.

Includes:

- data flows
- state updates
- API/service boundaries
- dependency injection points
- schema/DTO/interface handoffs
- event, command, or message paths
- config loading
- secrets/config injection
- cross-language contracts
- generated-contract or manually duplicated contract paths
- hidden direct calls that bypass the intended seam

Core principle: every integration point should have clear ownership, one authoritative contract, and an enforceable way to detect broken or drifting wiring.

Required output:

```markdown
## Wiring & Integration lens output

**Selected candidate:**
**Real seam or invented seam:**
**Integration owner:**
**Authoritative contract:**
**Contract duplicates or drift points:**
**Hidden bypasses / stale paths:**
**Direction-of-flow concerns:**
**Boundary error/null/default handling:**
**Recommended enforceable check:**
**Out-of-scope adjacent wiring concerns:**
```

Checklist:

- Is this a real seam/boundary or an invented one?
- Who owns this integration point?
- Which module, layer, service, or language is responsible for the contract and its evolution?
- Is there exactly one authoritative definition of the contract?
- Is the contract represented as a schema, interface, DTO, event shape, generated type, build target, or documented protocol?
- Is the contract duplicated manually on both sides of the boundary?
- Are the contracts stable enough for the current slice?
- Do contract changes have visibility through tests, generated artifacts, CI, or review gates?
- Are there hidden bypasses, stale paths, direct imports across layers, or script-based workarounds that bypass the intended wiring?
- Is data flowing in the correct direction according to the architecture?
- Are internal details leaking across the boundary?
- Are errors, nullability, defaults, and edge cases explicitly handled and translated at this seam?
- Is configuration loaded through the intended seam, or through ad-hoc local access?
- Are state updates routed through one coordinated path, or through multiple uncoordinated paths?
- Can this wiring rule be turned into an enforceable check?

Enforceable checks:

- contract/schema compatibility test
- import/dependency-direction rule
- integration test at the seam covering happy path and key error cases
- seam test that exercises wiring without pulling in full domain logic
- static/lint rule detecting forbidden cross-layer imports
- static check detecting direct calls that bypass the intended interface
- type-level assertion for branded IDs, strict schemas, or validated boundary types
- generated-type diff check for DTOs, events, or schema artifacts
- CI gate that runs contract tests whenever either side of the boundary changes
- build graph visibility rule that prevents hidden dependencies
- config-loading test proving the intended injection path is used

Anti-patterns:

- direct calls across layers in multiple places
- duplicated DTOs or manual serialization logic on both sides of a boundary
- state updates through multiple uncoordinated paths
- config or secrets loaded ad hoc instead of through a single injected seam
- cross-language handoff with no generated or validated contract
- public interfaces widened just to reach an internal detail
- tests that pass only because they bypass the real integration path
- script-based workflows that skip the canonical build, service, or orchestration path
- a reachable stale implementation path still encoding old behavior
- a contract that exists only in comments, examples, or chat history
