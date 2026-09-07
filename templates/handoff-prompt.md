You are writing a HANDOFF document for a successor instance of yourself in this same Pi session.

Write the document to this exact path (create/overwrite):

{{handoffPath}}

Then update the plan file at `{{planFile}}` by appending a handoff marker that matches existing WP markup, for example:

<!-- handoff n={{handoffNumber}} file={{handoffPath}} ts={{timestamp}} -->

Do not summarize chat history. Write concise operational state plus path pointers.

{{hardCeilingNote}}

Required sections:

# Handoff {{handoffNumber}}

- Timestamp: {{timestamp}}
- Reason: {{reason}}

## Task goal
One short paragraph.

## Work packages
For every WP in `{{planFile}}`: status (`done` / `in-progress` / `blocked` / `todo`) and one line of explanation.

## Pointers
- Plan file: `{{planFile}}`
- This handoff: `{{handoffPath}}`
- Key files (paths only)
- Relevant git commits (hashes only, if any)

## Exact interrupt point
Where work stopped. Be precise (file, WP, unfinished check).

## Next actions
The next WP and the first concrete step.

## Risks and constraints
Anything the successor must not redo or violate.

After the file is on disk, stop. Do not start the next work package and do not keep reading files. A successor turn will resume automatically.
