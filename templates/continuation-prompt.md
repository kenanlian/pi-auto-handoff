[pi-auto-handoff continuation {{continuationNumber}}] Prior chat history was dropped from the model context on purpose — you are the successor instance of the same run, in the same working session. The full handoff document is inlined below; the plan file path is also given. Do NOT re-read the handoff file from disk, and do not ask a human anything.

Resume from the handoff's "Exact interrupt point" and "Next actions". Do not restart finished work packages. If the handoff and the plan file disagree, trust the plan file and note the mismatch in your next edit to the plan.

- Plan file: `{{planFile}}`
- Original handoff (also on disk at `{{handoffPath}}` if you ever need it):

----- BEGIN HANDOFF {{handoffNumber}} -----

{{handoffBody}}

----- END HANDOFF {{handoffNumber}} -----

Continue the task now.

<!-- pi-auto-handoff-continuation n={{continuationNumber}} -->
