# pi-auto-handoff

Pi **0.85.x** extension that, on long tasks, performs **handoff → drop active model context → continue** while keeping the **same process PID and logical session id**.

Trigger is **two-sided**: context occupancy must exceed a threshold **and** a work-package (WP) boundary must have just completed. A **hard ceiling** fires even mid-WP (the model is told to finish and persist the current WP first). Occupancy uses Pi's authoritative `ctx.getContextUsage()` / last-assistant `Usage` (`calculateContextTokens`), never a character-count heuristic as the primary trigger.

```
contextTokens = usage.totalTokens || input + output + cacheRead + cacheWrite
ratio         = ctx.getContextUsage().percent / 100
              = contextTokens / model.contextWindow
```

This is not OpenCode's plugin API. Pi's equivalent of an in-place history splice is the `context` event (messages sent to the next LLM call). Durable session JSONL is append-only and is not deleted.

## Install (local)

This repository is the extension. Load it with `-e` (no global Pi config change required):

```bash
pi --no-extensions -e /Users/kenan/Secret-Projects/pi-auto-handoff/src/index.ts
```

Or point Pi settings at this package (project-local `.pi/settings.json`, after the project is trusted):

```json
{
  "extensions": ["/Users/kenan/Secret-Projects/pi-auto-handoff"],
  "packages": ["/Users/kenan/Secret-Projects/pi-auto-handoff"]
}
```

Copying `src/index.ts` into `.pi/extensions/` also auto-discovers, but **file options are then empty** — prefer `-e` plus `.pi/auto-handoff.json` so configuration is explicit.

Requires Pi **0.85.x** (verified on **0.85.1**).

```bash
npm test
npx tsc --noEmit
npm run smoke
```

## Configuration

All keys are optional. Place them in `.pi/auto-handoff.json` (or `.pi/auto-handoff.local.json`). `PI_AUTO_HANDOFF_*` environment variables override the file.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `PI_AUTO_HANDOFF_ENABLED` | `true` | Master switch |
| `contextThreshold` | `PI_AUTO_HANDOFF_CONTEXT_THRESHOLD` | `0.5` | Soft trigger (needs WP boundary) |
| `hardCeiling` | `PI_AUTO_HANDOFF_HARD_CEILING` | `0.75` | Always trigger |
| `assumedContextLimit` | `PI_AUTO_HANDOFF_ASSUMED_CONTEXT_LIMIT` | `200000` | Used if `ctx.model.contextWindow` is missing (warns once) |
| `handoffDir` | `PI_AUTO_HANDOFF_HANDOFF_DIR` | `.pi/handoff` | Where `handoff-NNN-<timestamp>.md` is written |
| `planFile` | `PI_AUTO_HANDOFF_PLAN_FILE` | `.pi/plan/active-plan.md` | WP status markdown |
| `handoffPromptFile` | `PI_AUTO_HANDOFF_HANDOFF_PROMPT_FILE` | bundled `templates/handoff-prompt.md` | Handoff instructions |
| `continuationPromptFile` | `PI_AUTO_HANDOFF_CONTINUATION_PROMPT_FILE` | bundled `templates/continuation-prompt.md` | Resume instructions |
| `continuationPrompt` | `PI_AUTO_HANDOFF_CONTINUATION_PROMPT` | `""` | Inline continuation override (wins over file) |
| `minTurnsBetweenHandoffs` | `PI_AUTO_HANDOFF_MIN_TURNS` | `3` | Debounce (completed assistant turns) |
| `logging` | `PI_AUTO_HANDOFF_LOGGING` | `true` | JSON lines on stderr + `handoffDir/.auto-handoff-events.jsonl` |
| `handoffTimeoutMs` | `PI_AUTO_HANDOFF_TIMEOUT_MS` | `90000` | Wait for the handoff file; one retry, then give up |
| `logFile` | `PI_AUTO_HANDOFF_LOG_FILE` | `""` | Optional extra JSONL log path |

See `auto-handoff.example.json`. `/auto-handoff` prints a JSON status snapshot.

## Work-package file format

Human-readable markdown. The extension understands:

**Checklists**

```markdown
- [x] **WP-1** Spike
- [~] **WP-2** Implement
- [!] **WP-3** Blocked
- [ ] **WP-4** Later
```

**Status tables**

```markdown
| ID | Status | Notes |
| --- | --- | --- |
| WP-01 | verified | … |
| WP-02 | in-progress | … |
```

Done-like statuses: `done`, `verified`, `complete`, checklist `[x]`.
A **WP boundary** is a WP whose status **became** done-like since the last snapshot the extension took.

Handoffs are recorded as HTML comments (and a `## Handoffs` section is created if needed):

```html
<!-- handoff n=1 file=.pi/handoff/handoff-001-….md ts=2026-09-07T00:00:00.000Z -->
```

## Handoff template

The bundled prompt asks the current model to write a short operational document (goal, WP states, path/commit pointers, interrupt point, next actions, risks) to an **exact path** under `handoffDir`. The file is verified for those headings before context is reduced. Placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{handoffNumber}}`, `{{timestamp}}`, `{{reason}}`, `{{hardCeilingNote}}`.

Continuation placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{nextWp}}`.

## Lifecycle

```
turn_end / getContextUsage
        │
        ├─ occupancy < threshold → keep working
        ├─ occupancy ≥ threshold and no new WP done → keep working
        ├─ occupancy ≥ hardCeiling → request handoff (even mid-WP)
        └─ occupancy ≥ threshold and WP just completed → request handoff
                │
                ├─ tool in flight → wait
                ├─ before_agent_start appends handoff instructions
                ├─ or agent_end queues pi.sendUserMessage(..., { deliverAs: "followUp" })
                │
                ├─ handoff file verified (required sections)
                ├─ context event: splice LLM messages once (messages-cleared)
                ├─ later LLM calls keep post-clear messages (filter-since / cursor)
                └─ if the run already idled: one continuation user message
```

Same-process continuation uses Pi's documented `agent_end` → `sendUserMessage({ deliverAs: "followUp" })` path. Print/JSON mode keeps waiting because `_handlePostAgentRun` continues the original `prompt()` when follow-ups are queued.

## How clearing works (0.85.1)

- **Clear once:** after the handoff file is verified, the next `context` event returns a continuation payload instead of the full branch (`messages-cleared` once). Later calls **keep** messages created after that snapshot so context can grow again (and so the model does not lose its own tool results). Durable JSONL (`SessionManager` append-only file, `PI_SESSION_FILE`) is **not** deleted.
- **Not used as the primary reducer:** `ctx.compact()`. Manual compaction from `agent_end` calls `abort()` → `waitForIdle()`, which cannot settle until after the handler returns (deadlock or post-exit race in print mode). Built-in `/handoff` creates a **new session** and is rejected for this extension.
- **Continue:** same-session `pi.sendUserMessage` follow-up (a real user message in the JSONL). PID and `PI_SESSION_ID` stay the same.
- System prompt / prompt cache remains. Conversation tokens drop on the first post-clear call, then rise again as work continues.

## Architecture

| Module | Role |
| --- | --- |
| `src/index.ts` | Pi `ExtensionAPI` factory: `session_start`, `turn_end`, `context`, `agent_end`, tool events, `/auto-handoff` |
| `src/runtime.ts` | Trigger, verify, inject, transform |
| `src/machine.ts` | Phase machine + debounce |
| `src/cycle.ts` | One-clear-then-filter cycle (F1/F2) |
| `src/usage.ts` | Pi usage / occupancy |
| `src/plan.ts` | WP markdown |
| `src/messages.ts` | LLM-message splice + handoff-file verification |
| `src/config.ts` | Defaults, JSON file, env |

## Verification

```bash
npm test          # unit tests
npx tsc --noEmit  # typecheck
npm run smoke     # real headless Pi: trigger → handoff file → context reduction → continuation → exit 0
```

`npm run smoke` launches `pi --mode json` with `--no-extensions -e ./src/index.ts` only. It does not write `~/.pi/agent/settings.json`. On success it removes `.smoke/` unless `SMOKE_KEEP=1`.

## Known limits

- **0.85.x.** Other Pi majors are untested.
- Handoff is requested only when **no tool is in flight**.
- If the model does not write a valid handoff file, the extension retries once then **gives up** (`handoff-give-up`) so the task cannot hang.
- Per handoff, logs fire once in order: `handoff-requested` → `handoff-written` → `clearing` / `messages-cleared` → `continuation-projected` (in-run splice) and/or `continuation-injected` (idle follow-up). Exactly one continuation path runs. `messages-cleared` must not repeat on every model call.
- `ctx.compact()` is not the primary reducer (see above). Auto-compaction may still run later using Pi's own threshold; this extension does not delete history to emulate it.
- Built-in Pi `/handoff` starts a new session. This extension never calls `ctx.newSession()`.
- Character-count estimates may appear *inside* Pi's `getContextUsage()` trailing-token fallback. This extension does not implement its own char heuristic and will not trigger without Pi-reported tokens/percent or last-assistant `Usage`.

## License

Use with your Pi installation. No npm publish from this tree unless you choose to later.
