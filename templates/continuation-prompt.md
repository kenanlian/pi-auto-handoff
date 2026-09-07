Continue the same task in this same Pi session. Prior chat history has been dropped from the model context on purpose.

Read, in order:
1. Handoff: `{{handoffPath}}`
2. Plan: `{{planFile}}`

Resume from the next incomplete work package. Do not restart finished WPs. Do not ask a human to confirm. If the handoff and plan disagree, trust the plan file's WP table and note the mismatch in your next edit to the plan.

Do not write another handoff file unless a new handoff prompt names an exact unused path. Do not re-read the handoff and plan in a loop.
