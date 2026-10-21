# Cross-system sweep

Use for `AUTHORIZATION_BOUNDARY_CHANGE`, `CROSS_REPOSITORY_CONTRACT_CHANGE`, `HIGH_DEPENDENCY_FANOUT`, `MULTIPLE_DEPLOYABLE_UNITS`, or `EXPLICIT_REQUEST` when no narrower procedure covers the risk.

Traverse the revision-bound graph from each changed component. Include service registries, deploy/build configuration, environment contracts, client packages, fallbacks, and safety checks. Separate repository evidence from live-system claims. Pause for unresolved authorization or security semantics. Verify representative paths in every affected deployable unit; if an external repository or live system is unavailable, mark that boundary unverified rather than assuming coherence.
