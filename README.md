# pi-auto-handoff (v2)

Pi **0.85.x** extension that performs **handoff → drop active model context → continue** while keeping the **same process PID and logical session id** — triggered **mid-run** from the `context` event, no run boundary required.

v2 trigger shape: **one threshold** (`contextThreshold`, default `0.5`). When context occupancy exceeds the threshold while the run is still going, the next `context` event (fired before every LLM call) appends a strong handoff directive to that very call's message array. The model never has to reach a text-only turn first. Because the injected message does not persist in session state, the ratio stays over-threshold and the directive is **re-injected on every subsequent LLM call** until the handoff file is verified — the instruction stays in the room; the model cannot "forget" it.

Occupancy uses Pi's authoritative `ctx.getContextUsage()` / last-assistant `Usage` (`calculateContextTokens`), never a character-count heuristic as the primary trigger.

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
| `contextThreshold` | `PI_AUTO_HANDOFF_CONTEXT_THRESHOLD` | `0.5` | Single trigger threshold; ratio ≥ threshold on a `context` event fires the handoff |
| `assumedContextLimit` | `PI_AUTO_HANDOFF_ASSUMED_CONTEXT_LIMIT` | `200000` | Used if `ctx.model.contextWindow` is missing (warns once) |
| `handoffDir` | `PI_AUTO_HANDOFF_HANDOFF_DIR` | `.pi/handoff` | Where `handoff-NNN-<timestamp>.md` is written |
| `planFile` | `PI_AUTO_HANDOFF_PLAN_FILE` | `.pi/plan/active-plan.md` | Path pointer passed through to the templates (not parsed) |
| `handoffPromptFile` | `PI_AUTO_HANDOFF_HANDOFF_PROMPT_FILE` | bundled `templates/handoff-prompt.md` | Handoff directive |
| `continuationPromptFile` | `PI_AUTO_HANDOFF_CONTINUATION_PROMPT_FILE` | bundled `templates/continuation-prompt.md` | Resume message |
| `continuationPrompt` | `PI_AUTO_HANDOFF_CONTINUATION_PROMPT` | `""` | Inline continuation override (wins over file) |
| `logging` | `PI_AUTO_HANDOFF_LOGGING` | `true` | JSON lines on stderr + `handoffDir/.auto-handoff-events.jsonl` |
| `handoffTimeoutMs` | `PI_AUTO_HANDOFF_TIMEOUT_MS` | `90000` | Wait for the handoff file; one retry, then give up |
| `logFile` | `PI_AUTO_HANDOFF_LOG_FILE` | `""` | Optional extra JSONL log path |

Removed in v2 (silently ignored if present): `hardCeiling`, `minTurnsBetweenHandoffs`, and plan-file content parsing (WP boundaries are no longer detected — the plan file survives only as a `{{planFile}}` path pointer inside templates).

See `auto-handoff.example.json`. `/auto-handoff` prints a JSON status snapshot.

## Lifecycle (v2)

```
context event (before every LLM call)
        │
        ├─ ratio < threshold → keep working
        └─ ratio ≥ threshold, phase = monitoring, no tool in flight
                │
                ├─ handoff-requested (number N assigned, path picked)
                ├─ handoff-injected: directive appended to THIS call's array
                │    (fixed key `handoff-inject:N`; same directive re-injected
                │     on every later LLM call until the file verifies)
                │
                ├─ model writes handoff-NNN-*.md (six required sections)
                ├─ tool_execution_end verifies → handoff-written
                │
                ├─ model still running → next context event first-clears:
                │    whole array replaced by the continuation user message
                │    (inlined handoff document + plan path + marker)
                ├─ model already stopped → agent_end relights the same session
                │    via sendUserMessage (real user message in the JSONL)
                │
                └─ later calls filter-since: keep continuation + new messages
```

Event log order per handoff: `handoff-requested` → `handoff-injected` (1..N, once per LLM call) → `handoff-written` → `clearing` / `messages-cleared` → `continuation-projected` (in-run) or `continuation-injected` (idle relight). Exactly one continuation path runs per handoff; `messages-cleared` does not repeat per LLM call.

## Templates

**Handoff directive** (`templates/handoff-prompt.md`): a strong instruction — context is at its limit; **continuing the original task is forbidden**; only the minimal tool calls needed to write the document are allowed; write to the exact `{{handoffPath}}`; six required `##` sections; end the turn with `HANDOFF WRITTEN`. Placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{handoffNumber}}`, `{{timestamp}}`, `{{reason}}`, `{{ratio}}`, `{{threshold}}`.

**Continuation** (`templates/continuation-prompt.md`): the successor's first user message. Inlines the **full handoff document** (`{{handoffBody}}`, several KB — no re-read needed), adds the plan path, and ends with the machine marker `<!-- pi-auto-handoff-continuation n=N -->`. Placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{handoffNumber}}`, `{{handoffBody}}`, `{{continuationNumber}}`.

Verification (`verifyHandoffBody`): exact `{{handoffPath}}` match on disk, all six headings (`## Task goal`, `## Work packages`, `## Pointers`, `## Exact interrupt point`, `## Next actions`, `## Risks`), body ≥ 40 chars.

## session_start restore (optional, on by default)

If the process dies mid-task and Pi restarts with the same `--session-id`, Pi rebuilds full history from the JSONL, but the extension instance is fresh — without help it would see over-threshold ratio again and inject a whole new handoff (self-healing but wasteful). On `session_start` (`startup`/`resume`) the extension scans the durable branch for the newest user message containing the `<!-- pi-auto-handoff-continuation n=... -->` marker, records every message id at or before it into `preClearIds`, and the projection state is restored immediately (`session-restored` log). The next `context` event filters instead of re-clearing, and a fresh handoff only happens if the *new* context genuinely crosses the threshold again.

## How clearing works (0.85.1)

- **Clear once:** after the handoff file is verified, the next `context` event returns a continuation payload instead of the full branch (`messages-cleared` once). Later calls **keep** messages created after that snapshot so context can grow again (and so the model does not lose its own tool results). Durable JSONL (`SessionManager` append-only file, `PI_SESSION_FILE`) is **not** deleted.
- **Stale-usage guard:** after a clear (or restore), `getContextUsage()` still reflects the pre-clear last-assistant usage, which would instantly re-trigger. The extension ignores occupancy until the next real assistant usage arrives (`awaitingFreshUsage`).
- **Continue:** same-session `pi.sendUserMessage` follow-up (a real user message in the JSONL). PID and `PI_SESSION_ID` stay the same.
- System prompt / prompt cache remains. Conversation tokens drop on the first post-clear call, then rise again as work continues.

## What v2 deliberately does NOT handle

- Runs that finish normally under the threshold — the final report is the natural handoff.
- Runs that cross the threshold just as they end — same.
- The model ignoring the directive: Pi's own auto-compaction (window − 16384 tokens ≈ 92%) and the outer Watson supervision loop are the backstops; not this extension's job. An optional loose warning (`warn` log after N minutes of continuous injection with no document) may be added later.
- `agent_end` is **not** a handoff delivery channel anymore; it only relights a written handoff when the model has stopped. `before_agent_start` system-prompt injection is gone.

## Architecture

| Module | Role |
| --- | --- |
| `src/index.ts` | Pi `ExtensionAPI` factory: `session_start`, `context` (trigger + inject + transform), `agent_end` (idle relight), tool events, `/auto-handoff` |
| `src/runtime.ts` | Trigger, inject, verify, transform, restore |
| `src/machine.ts` | Single-threshold phase machine (monitoring → injecting → written) |
| `src/cycle.ts` | One-clear-then-filter cycle |
| `src/usage.ts` | Pi usage / occupancy |
| `src/messages.ts` | LLM-message splice, inject keys, continuation marker, handoff-file verification |
| `src/config.ts` | Defaults, JSON file, env |

## Verification

```bash
npm test          # unit tests
npx tsc --noEmit  # typecheck
npm run smoke     # real headless Pi: inject → handoff file → context reduction → same-session continuation → exit 0
```

`npm run smoke` launches `pi --mode json` with `--no-extensions -e ./src/index.ts` only, `contextThreshold=0.0001` so the first `context` event fires. It does not write `~/.pi/agent/settings.json`. On success it removes `.smoke/` unless `SMOKE_KEEP=1`.

## Known limits

- **0.85.x.** Other Pi majors are untested.
- The handoff is requested only when **no tool is in flight** (deferred to the next `context` event otherwise).
- If the model does not write a valid handoff file, the extension retries once then **gives up** (`handoff-give-up`) so the task cannot hang.
- Character-count estimates may appear *inside* Pi's `getContextUsage()` trailing-token fallback. This extension does not implement its own char heuristic and will not trigger without Pi-reported tokens/percent or last-assistant `Usage`.
- Built-in Pi `/handoff` starts a new session. This extension never calls `ctx.newSession()`.

## License

Use with your Pi installation. No npm publish from this tree unless you choose to later.
