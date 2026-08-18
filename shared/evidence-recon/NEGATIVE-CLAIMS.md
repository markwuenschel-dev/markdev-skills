# Negative Claims and Coverage Receipts

Negative claims are the highest-risk evidence statements because “not found” is easy to produce and hard to justify.

Examples:

- no other callers exist;
- nothing tests this behavior;
- this path is unused;
- no migration exists;
- only one component owns this state;
- the repository does not contain generated code;
- no documentation defines the contract.

Every such assertion belongs in `negative_claims`, not hidden inside an ordinary claim.

## Required receipt

A negative claim records:

- the exact statement;
- the search scope;
- every search method used;
- explicit exclusions, including an empty list when there were none;
- source receipts (search output, inventories, paths, commands, or primary records);
- coverage state and evidence quality;
- `search_completeness`;
- whether the evidence actually `supports_absence`.

`supports_absence: true` is valid only when:

- coverage is `inspected`;
- evidence quality is `strong` or `moderate`;
- completeness is `bounded-exhaustive` or `repository-exhaustive`;
- search scope, methods, and sources are non-empty;
- exclusions are explicitly recorded.

Otherwise record `supports_absence: false` and phrase the result honestly: “No additional path was found in the sampled surface,” not “No additional path exists.”

## Bounded versus repository exhaustive

`bounded-exhaustive` means every member of a declared finite surface was checked—for example all registered route modules or every file in a generated inventory.

`repository-exhaustive` means the repository-wide search strategy is sufficient for the claim, including alternate registration, generated/runtime paths, and relevant exclusions. It is rare and should be expensive to assert.

A search command alone is not proof if the symbol can be aliased, generated, dynamically registered, or created outside the searched language surface. The receipt must explain why the method matches the claim.
