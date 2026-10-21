# Light sweep

Use only for `INTERNAL_MULTI_FILE` or `DEPENDENCY_FANOUT_PRESENT`.

1. Search for direct imports, calls, configuration lookups, and tests of the changed component.
2. Check one layer of sibling or fallback implementations for mirrored behavior.
3. Update only dependents that must change for the requested internal behavior; do not expand into unrelated cleanup.
4. Run the smallest repository-declared test or static check that exercises the changed seam.
5. Report the search and test commands. Escalate through the gate again if evidence reveals a full-level signal.
