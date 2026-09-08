import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { envOverrides, parseConfig } from "../src/config.ts"
import { applyClear, applyFilterSince, verifyHandoffBody } from "../src/messages.ts"
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

describe("config", () => {
  it("clamps and fills defaults", () => {
    const cfg = parseConfig({ contextThreshold: 0.2, enabled: false })
    assert.equal(cfg.contextThreshold, 0.2)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.handoffDir, ".pi/handoff")
    assert.equal(parseConfig({}).contextThreshold, 0.5)
  })

  it("clamps out-of-range thresholds", () => {
    assert.equal(parseConfig({ contextThreshold: 5 }).contextThreshold, 1)
    assert.equal(parseConfig({ contextThreshold: -1 }).contextThreshold, 0)
  })

  it("ignores removed v1 keys (hardCeiling, minTurnsBetweenHandoffs)", () => {
    const cfg = parseConfig({ hardCeiling: 0.9, minTurnsBetweenHandoffs: 3 } as Record<string, unknown>)
    assert.equal("hardCeiling" in cfg, false)
    assert.equal("minTurnsBetweenHandoffs" in cfg, false)
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

  it("no env mapping remains for removed keys", () => {
    const env = envOverrides({
      PI_AUTO_HANDOFF_HARD_CEILING: "0.9",
      PI_AUTO_HANDOFF_MIN_TURNS: "3",
    })
    assert.deepEqual(env, {})
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

  it("leaves unknown placeholders empty rather than literal", () => {
    const out = render("x={{unknown}} y=1", { y: "1" } as Record<string, string>)
    assert.equal(out, "x= y=1")
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
