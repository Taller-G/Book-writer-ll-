<!-- chiron-memory:start -->
# Project memory (chiron-memory)

This project uses chiron-memory: `chiron-memory/` holds atomic knowledge items
(decisions, conventions, gotchas) that future sessions retrieve. The
`chiron-memory` skill defines the format.

- **Before working**: search the project memory — it may already have the
  answer. Use the memory MCP tools when available (`memory_search`,
  `memory_canonical`), else `chiron-memory search "<topic>"`. Always do
  this, even when the task seems obvious.
- **When you learn something** (a decision with its why, a gotcha, a
  convention): record it in its type's file under `chiron-memory/` right then,
  in the What · Why · Where · Learned format. Don't leave it for the end.
- **Before finishing**: if you touched behavior/architecture and recorded
  nothing, record what you learned. Validate with `chiron-memory check`
  when that CLI is installed.
- Never use `chiron-memory/` as a journal or changelog — durable, reusable
  knowledge only.
<!-- chiron-memory:end -->
