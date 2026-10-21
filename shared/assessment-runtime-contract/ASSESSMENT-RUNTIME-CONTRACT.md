# Assessment Runtime Contract

A parent orchestrator reads this small, source-owned machine contract instead of rereading and summarizing each child skill's full implementation guide. The child still owns and reads its full skill when invoked. Parallel file reads are preferred over subagents for loading these contracts.

The contract prevents interpretation drift while removing repeated 150–500 line parent-side contract reading from every RIA run.
