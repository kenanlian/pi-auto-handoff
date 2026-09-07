import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { envOverrides, parseConfig } from "../src/config.ts"
import { applyClear, applyFilterSince, verifyHandoffBody } from "../src/messages.ts"
import { appendHandoffMarker, newlyCompleted, parsePlan } from "../src/plan.ts"
import { nextHandoffPath } from "../src/paths.ts"
import { render } from "../src/templates.ts"
import {
  contextTokens,
  hasAuthoritativeContextUsage,
  hasAuthoritativeUsage,
  occupancy,
  occupancyFromContextUsage,
} from "../src/usage.ts"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("usage", () => {
  it("uses Pi calculateContextTokens formula, not a character heuristic", () => {
    const usage = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 10, totalTokens: 1260 }
    assert.equal(contextTokens(usage), 1260)
    assert.equal(occupancy(usage, 2000), 0.63)
    assert.equal(hasAuthoritativeUsage(usage), true)
    assert.equal(hasAuthoritativeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false)
  })

  it("falls back to component sum when totalTokens is missing", () => {
    const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 5 }
    assert.equal(contextTokens(usage), 130)
  })

  it("reads occupancy from ctx.getContextUsage percent and tokens", () => {
    assert.equal(occupancyFromContextUsage({ tokens: 50_000, contextWindow: 100_000, percent: 50 }), 0.5)
    assert.equal(occupancyFromContextUsage({ tokens: 25_000, contextWindow: 100_000, percent: null }), 0.25)
    assert.equal(hasAuthoritativeContextUsage({ tokens: 1, contextWindow: 1000, percent: 0.1 }), true)
    assert.equal(hasAuthoritativeContextUsage({ tokens: null, contextWindow: 1000, percent: null }), false)
  })
})

describe("parsePlan", () => {
  it("reads checkbox and table WPs plus handoff markers", () => {
    const md = `
# Plan
- [x] **WP-1** Spike
- [ ] **WP-2** Implement

| ID | Status | Notes |
| --- | --- | --- |
| WP-03 | in-progress | coding |
| WP-04 | blocked | wait |

<!-- handoff n=2 file=.pi/handoff-002.md ts=2026-09-02T00:00:00Z -->
`
    const snap = parsePlan(md)
    assert.deepEqual(
      snap.packages.map((p) => [p.id, p.status]),
      [
        ["WP-03", "in-progress"],
        ["WP-04", "blocked"],
        ["WP-1", "done"],
        ["WP-2", "todo"],
      ],
    )
    assert.equal(snap.handoffCount, 2)
  })

  it("detects a WP that just completed", () => {
    const prev = parsePlan("- [ ] **WP-1** A\n- [ ] **WP-2** B\n")
    const next = parsePlan("- [x] **WP-1** Spike\n- [ ] **WP-2** Implement\n")
    assert.deepEqual(newlyCompleted(prev, next), ["WP-1"])
    assert.deepEqual(newlyCompleted(next, next), [])
  })

  it("appends a handoff marker without duplicating", () => {
    const once = appendHandoffMarker("# Plan\n<!-- handoffs -->\n", {
      n: 1,
      file: "a.md",
      ts: "t",
    })
    assert.match(once, /handoff n=1/)
    const twice = appendHandoffMarker(once, { n: 1, file: "a.md", ts: "t" })
    assert.equal(twice, once)
  })
})

describe("config", () => {
  it("clamps and fills defaults", () => {
    const cfg = parseConfig({ contextThreshold: 0.2, hardCeiling: 0.1, enabled: false })
    assert.equal(cfg.contextThreshold, 0.2)
    assert.equal(cfg.hardCeiling, 0.2)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.handoffDir, ".pi/handoff")
  })

  it("reads PI_AUTO_HANDOFF_* env overrides", () => {
    const env = envOverrides({
      PI_AUTO_HANDOFF_CONTEXT_THRESHOLD: "0.0001",
      PI_AUTO_HANDOFF_HANDOFF_DIR: "/tmp/h",
      PI_AUTO_HANDOFF_ENABLED: "true",
    })
    const cfg = parseConfig(env)
    assert.equal(cfg.contextThreshold, 0.0001)
    assert.equal(cfg.handoffDir, "/tmp/h")
    assert.equal(cfg.enabled, true)
  })
})

describe("handoff path and template", () => {
  it("writes numbered handoff-NNN-timestamp.md names", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-handoff-path-"))
    const path = nextHandoffPath("out", dir, 7, new Date("2026-09-07T00:00:00.000Z"))
    assert.match(path, /handoff-007-2026-09-07T00-00-00-000Z\.md$/)
    assert.deepEqual(readdirSync(join(dir, "out")), [])
  })

  it("renders placeholders", () => {
    const out = render("path={{handoffPath}} n={{handoffNumber}}", {
      handoffPath: "/tmp/h.md",
      handoffNumber: "3",
    })
    assert.equal(out, "path=/tmp/h.md n=3")
  })

  it("rejects incomplete handoff bodies and accepts required sections", () => {
    assert.equal(verifyHandoffBody("too short"), false)
    assert.equal(
      verifyHandoffBody(`# Handoff 1
## Task goal
Do the thing.
## Work packages
WP-1 done.
## Pointers
- a.ts
## Exact interrupt point
After WP-1.
## Next actions
WP-2.
## Risks and constraints
Do not redo WP-1.
`),
      true,
    )
  })
})

describe("messages.applyClear", () => {
  it("drops history before a cursor id", () => {
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "old" }] },
      { role: "assistant", timestamp: 2, model: "m" },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "go" }] },
    ]
    const keepFromId = "u:3:go"
    const result = applyClear(messages, { keepFromId })
    assert.equal(result.mode, "cursor")
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.timestamp, 3)
  })

  it("keeps the continuation clone plus messages absent from the pre-clear snapshot", () => {
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "old" }] },
      { role: "assistant", timestamp: 2, model: "m" },
      { role: "assistant", timestamp: 3, model: "m", responseId: "new" },
    ]
    const pre = new Set(["u:1:old", "a:2:m:"])
    const result = applyFilterSince(messages, pre, "continue")
    assert.equal(result.mode, "since")
    assert.equal(messages.length, 2)
    assert.equal((messages[0]?.content as { text: string }[])[0]?.text, "continue")
    assert.equal(messages[1]?.timestamp, 3)
  })
})
