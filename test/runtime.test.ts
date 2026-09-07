import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { parseConfig } from "../src/config.ts"
import type { AgentMessageLike } from "../src/messages.ts"
import {
  applyContextTransform,
  considerTrigger,
  createRuntime,
  maybeTimeout,
  noteAssistantUsage,
  noteToolEnd,
  noteToolStart,
  refreshOccupancy,
  runIdlePlan,
  type Runtime,
} from "../src/runtime.ts"

type LogEvent = { message: string; extra: Record<string, unknown> }

function count(logs: LogEvent[], name: string): number {
  return logs.filter((e) => e.message === name).length
}

function captureLogs(rt: Runtime, logs: LogEvent[]): void {
  const inner = rt.log.log.bind(rt.log)
  rt.log.log = (level, message, extra) => {
    logs.push({ message, extra: extra ?? {} })
    inner(level, message, extra)
  }
}

function validHandoff(): string {
  return `# Handoff 1
- Timestamp: t
- Reason: threshold-wp

## Task goal
Finish the smoke.

## Work packages
WP-1 done, WP-2 todo.

## Pointers
- plan.md
- key files

## Exact interrupt point
After WP-1.

## Next actions
WP-2 write done file.

## Risks and constraints
Do not redo WP-1.
`
}

function boot(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-handoff-rt-"))
  const handoffDir = join(dir, "handoff")
  mkdirSync(handoffDir)
  const planFile = join(dir, "plan.md")
  writeFileSync(
    planFile,
    `# Plan
- [ ] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
  )
  const prompts: string[] = []
  const logs: LogEvent[] = []
  const rt = createRuntime({
    cfg: parseConfig({
      enabled: true,
      contextThreshold: 0.0001,
      hardCeiling: 0.99,
      minTurnsBetweenHandoffs: 0,
      handoffDir,
      planFile,
      logging: true,
      handoffTimeoutMs: 50,
      ...overrides,
    }),
    directory: dir,
    hooks: {
      sendUserMessage: (text) => {
        prompts.push(text)
      },
      getContextUsage: () => ({ tokens: 200, contextWindow: 200_000, percent: 0.1 }),
      getModelContextWindow: () => 200_000,
    },
  })
  captureLogs(rt, logs)
  return { rt, logs, prompts, dir, handoffDir, planFile }
}

describe("runtime: no handoff while a tool is in flight", () => {
  it("does not request a handoff during an open tool call", () => {
    const { rt, logs, planFile } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 }, true)
    refreshOccupancy(rt)
    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )
    noteToolStart(rt)
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 0)
    noteToolEnd(rt)
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 1)
  })
})

describe("runtime: tool-end verification without idle (F1)", () => {
  it("applies messages-cleared once and then keeps new assistant messages", () => {
    const { rt, logs, prompts, planFile } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 }, true)
    refreshOccupancy(rt)
    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 1)
    const requested = logs.find((e) => e.message === "handoff-requested")
    const path = String(requested?.extra.path ?? "")
    assert.match(path, /handoff-001-/)
    writeFileSync(path, validHandoff())

    noteToolStart(rt)
    noteToolEnd(rt)
    noteToolEnd(rt)
    assert.equal(count(logs, "handoff-written"), 1)

    const firstCall: AgentMessageLike[] = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "original task" }] },
      { role: "assistant", timestamp: 2, model: "m", content: [{ type: "text", text: "working" }] },
      { role: "assistant", timestamp: 3, model: "m", content: [{ type: "text", text: "wrote file" }] },
    ]
    applyContextTransform(rt, firstCall)
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "clearing"), 1)
    assert.equal(firstCall.length, 1)
    assert.match(String((firstCall[0]?.content as { text: string }[])[0]?.text ?? ""), /WP-2|handoff|Continue/i)

    for (let i = 0; i < 8; i++) {
      const next: AgentMessageLike[] = [
        { role: "user", timestamp: 1, content: [{ type: "text", text: "original task" }] },
        { role: "assistant", timestamp: 2, model: "m", content: [{ type: "text", text: "working" }] },
        { role: "assistant", timestamp: 3, model: "m", content: [{ type: "text", text: "wrote file" }] },
        { role: "assistant", timestamp: 4, model: "m", content: [{ type: "text", text: "read handoff" }] },
        { role: "assistant", timestamp: 100 + i, model: "m", content: [{ type: "text", text: `step ${i}` }] },
      ]
      applyContextTransform(rt, next)
      assert.ok(next.length >= 3, `step ${i} should keep post-clear messages, got ${next.length}`)
      assert.equal(next.at(-1)?.timestamp, 100 + i)
    }

    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "handoff-written"), 1)
    assert.equal(count(logs, "continuation-projected"), 1)
    assert.equal(count(logs, "continuation-injected"), 0)
    assert.equal(prompts.length, 0)
  })
})

describe("runtime: idle continuation and timeout give-up", () => {
  it("injects one continuation after a verified handoff when idle", () => {
    const { rt, logs, prompts, planFile } = boot()
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 }, true)
    refreshOccupancy(rt)
    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )
    const kind = runIdlePlan(rt)
    assert.equal(kind, "handoff")
    assert.equal(prompts.length, 1)
    const path = String(logs.find((e) => e.message === "handoff-requested")?.extra.path ?? "")
    writeFileSync(path, validHandoff())
    const cont = runIdlePlan(rt)
    assert.equal(cont, "continuation")
    assert.equal(prompts.length, 2)
    assert.equal(count(logs, "continuation-injected"), 1)
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(runIdlePlan(rt), "none")
  })

  it("retries once then gives up instead of hanging", () => {
    const { rt, logs, planFile } = boot({ handoffTimeoutMs: 1000 })
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 }, true)
    refreshOccupancy(rt)
    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )
    considerTrigger(rt)
    assert.ok(rt.pending)
    rt.pending.startedAt = Date.now() - 5000
    maybeTimeout(rt, Date.now())
    assert.equal(count(logs, "handoff-retry"), 1)
    assert.equal(rt.state.phase, "handoff-requested")
    assert.ok(rt.pending)
    rt.pending.startedAt = Date.now() - 5000
    maybeTimeout(rt, Date.now())
    assert.equal(count(logs, "handoff-give-up"), 1)
    assert.equal(rt.pending, null)
    assert.equal(rt.state.phase, "monitoring")
  })
})

describe("runtime: plan marker", () => {
  it("appends a handoff marker to the plan when the file is verified", () => {
    const { rt, planFile } = boot()
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 }, true)
    refreshOccupancy(rt)
    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )
    considerTrigger(rt)
    const path = rt.pending?.path
    assert.ok(path)
    writeFileSync(path, validHandoff())
    noteToolEnd(rt)
    const plan = readFileSync(planFile, "utf8")
    assert.match(plan, /<!-- handoff n=1 /)
  })
})
