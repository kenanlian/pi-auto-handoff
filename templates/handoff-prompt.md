[pi-auto-handoff] CONTEXT CRITICAL — WRITE HANDOFF NOW

Your context window is at or past {{threshold}} of its limit (current ratio {{ratio}}). If you keep working, the next tool results will push this run past its usable context and the work will degrade or stall.

You are FORBIDDEN from continuing the original task. From this point on you may use ONLY the minimal tool calls needed to write the handoff document (e.g. one read of the plan file). Do not start or continue any work package. Do not run more task tools. Do not reply with a task-progress answer.

Write the handoff document to this exact path (create/overwrite, nothing else in the file):

{{handoffPath}}

Required sections — all six, in this order, as `##` headings (the file is machine-verified):

# Handoff {{handoffNumber}}

- Timestamp: {{timestamp}}

## Task goal
One short paragraph: what the overall task is and who/what it is for.

## Work packages
Every work package from the plan file `{{planFile}}` with its current status (`done` / `in-progress` / `blocked` / `todo`) and one line each.

## Pointers
- Plan file: `{{planFile}}`
- This handoff: `{{handoffPath}}`
- Key files the successor must touch (absolute or repo-relative paths only)
- Relevant git commits (hashes only, if any)

## Exact interrupt point
Where work stopped right now. Be surgical: file path, function or WP, the last completed step, the unfinished check.

## Next actions
The immediate next work package and its first concrete step.

## Risks and constraints
Anything the successor must not redo, must not violate, or will likely trip over.

When the file is written, end your turn immediately with the single line:

HANDOFF WRITTEN

Do not do anything else after writing the file. The session will be continued for you automatically.
