import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { parseConfig } from "../src/config.ts"
import type { AgentMessageLike } from "../src/messages.ts"
import { injectKey } from "../src/messages.ts"
import {
  applyContextTransform,
  considerTrigger,
  createRuntime,
  maybeTimeout,
  noteAssistantUsage,
  noteToolEnd,
  noteToolStart,
  refreshOccupancy,
  restoreFromBranch,
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

## Task goal
Finish the smoke.

## Work packages
WP-1 done, WP-2 todo.

## Pointers
- plan.md

## Exact interrupt point
After WP-1.

## Next actions
WP-2 write done file.

## Risks and constraints
Do not redo WP-1.
`
}

function history(): AgentMessageLike[] {
  return [
    { role: "user", timestamp: 1, content: [{ type: "text", text: "original task" }] },
    { role: "assistant", timestamp: 2, model: "m", content: [{ type: "text", text: "working" }] },
    { role: "assistant", timestamp: 3, model: "m", content: [{ type: "text", text: "step" }] },
  ]
}

function boot(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-handoff-rt-"))
  const handoffDir = join(dir, "handoff")
  mkdirSync(handoffDir)
  const planFile = join(dir, "plan.md")
  writeFileSync(planFile, "# Plan\n")
  const prompts: string[] = []
  const logs: LogEvent[] = []
  const rt = createRuntime({
    cfg: parseConfig({
      enabled: true,
      contextThreshold: 0.0001,
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

describe("runtime: context event is the trigger (v2)", () => {
  it("requests and injects the directive in the same context event, mid-run", () => {
    const { rt, logs } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 })
    const messages = history()
    const out = applyContextTransform(rt, messages)
    assert.equal(count(logs, "handoff-requested"), 1)
    assert.equal(count(logs, "handoff-injected"), 1)
    assert.equal(out.injected, true)
    // directive appended as the last message
    const last = messages.at(-1)
    assert.equal(last?.role, "user")
    assert.match(String((last?.content as { text: string }[])[0]?.text), /FORBIDDEN/)
    const injectedLog = logs.find((e) => e.message === "handoff-injected")
    assert.equal(injectedLog?.extra.key, injectKey(1))
  })

  it("re-injects the same directive on every context event until verified", () => {
    const { rt, logs } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 })
    for (let i = 0; i < 5; i++) {
      const messages = history()
      const out = applyContextTransform(rt, messages)
      assert.equal(out.injected, true)
      assert.match(String((messages.at(-1)?.content as { text: string }[])[0]?.text), /FORBIDDEN/)
    }
    assert.equal(count(logs, "handoff-injected"), 5)
    assert.equal(count(logs, "handoff-requested"), 1)
    assert.equal(rt.pending?.number, 1)
  })

  it("does not trigger below threshold", () => {
    const { rt, logs } = boot({ contextThreshold: 0.9 })
    noteAssistantUsage(rt, { input: 100, output: 5, totalTokens: 105 })
    refreshOccupancy(rt)
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 0)
    assert.equal(rt.pending, null)
  })

  it("does not re-trigger after a clear until occupancy is observed below the threshold", () => {
    const { rt, logs } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 })
    const first = history()
    applyContextTransform(rt, first)
    assert.ok(rt.pending)
    writeFileSync(rt.pending.path, validHandoff())
    noteToolEnd(rt)
    const second = history()
    applyContextTransform(rt, second) // first-clear
    assert.equal(rt.armed, false)

    // post-clear observations still above the tiny threshold: no new handoff
    noteAssistantUsage(rt, { input: 300, output: 10, totalTokens: 310 })
    for (let i = 0; i < 3; i++) {
      const next = history()
      applyContextTransform(rt, next)
    }
    assert.equal(count(logs, "handoff-requested"), 1)
    assert.equal(count(logs, "messages-cleared"), 1)

    // occupancy drops below the threshold → re-armed; crossing again fires handoff #2
    rt.hooks.getContextUsage = () => ({ tokens: 1, contextWindow: 200_000, percent: 0.0005 })
    const grown = history()
    applyContextTransform(rt, grown)
    assert.equal(rt.armed, true)
    rt.hooks.getContextUsage = () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 })
    const over = history()
    applyContextTransform(rt, over)
    assert.equal(count(logs, "handoff-requested"), 2)
    assert.equal(rt.pending?.number, 2)
    assert.match(String((over.at(-1)?.content as { text: string }[])[0]?.text), /FORBIDDEN/)
  })

  it("does not trigger while a tool is in flight", () => {
    const { rt, logs } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 })
    refreshOccupancy(rt)
    noteToolStart(rt)
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 0)
    noteToolEnd(rt)
    considerTrigger(rt)
    assert.equal(count(logs, "handoff-requested"), 1)
  })
})

describe("runtime: verification and clearing (both paths, one each)", () => {
  it("model still running: first-clear via context, filter-since afterwards", () => {
    const { rt, logs, prompts } = boot()
    noteAssistantUsage(rt, { input: 200, output: 8, totalTokens: 208 })
    const first = history()
    applyContextTransform(rt, first) // request + inject
    assert.ok(rt.pending)

    // model writes the handoff file
    writeFileSync(rt.pending.path, validHandoff())
    noteToolEnd(rt) // main verification checkpoint
    assert.equal(count(logs, "handoff-written"), 1)

    // next context event: first-clear replaces the whole array
    const second = [...history(), { role: "assistant", timestamp: 4, model: "m", content: [{ type: "text", text: "HANDOFF WRITTEN" }] } as AgentMessageLike]
    applyContextTransform(rt, second)
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "clearing"), 1)
    assert.equal(second.length, 1)
    const cont = String((second[0]?.content as { text: string }[])[0]?.text)
    assert.match(cont, /pi-auto-handoff-continuation n=1/)
    assert.match(cont, /## Task goal/)

    // subsequent calls: filter-since keeps continuation + new messages, no re-clear
    for (let i = 0; i < 8; i++) {
      const next = [
        ...history(),
        { role: "assistant", timestamp: 4, model: "m", content: [{ type: "text", text: "wrote handoff" }] } as AgentMessageLike,
        { role: "assistant", timestamp: 100 + i, model: "m", content: [{ type: "text", text: `step ${i}` }] } as AgentMessageLike,
      ]
      applyContextTransform(rt, next)
      assert.ok(next.length >= 2, `step ${i} should keep post-clear messages, got ${next.length}`)
      assert.equal(next.at(-1)?.timestamp, 100 + i)
    }
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "handoff-written"), 1)
    assert.equal(count(logs, "continuation-projected"), 1)
    assert.equal(count(logs, "continuation-injected"), 0)
    assert.equal(prompts.length, 0)
  })

  it("model already stopped: agent_end relights via sendUserMessage", () => {
    const { rt, logs, prompts } = boot()
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 })
    const messages = history()
    applyContextTransform(rt, messages) // request + inject
    writeFileSync(rt.pending!.path, validHandoff())
    const outcome = runIdlePlan(rt)
    assert.equal(outcome, "continuation")
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]!, /pi-auto-handoff-continuation n=1/)
    assert.match(prompts[0]!, /## Task goal/)
    assert.equal(count(logs, "continuation-injected"), 1)
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(runIdlePlan(rt), "none")
  })

  it("continuation message inlines the handoff document", () => {
    const { rt } = boot()
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 })
    const messages = history()
    applyContextTransform(rt, messages)
    writeFileSync(rt.pending!.path, validHandoff())
    runIdlePlan(rt)
    // continuation built at verification time from the on-disk file
    const cont = rt.cycle.continuationText
    assert.match(cont, /## Task goal/)
    assert.match(cont, /## Exact interrupt point/)
    assert.match(cont, /pi-auto-handoff-continuation n=1/)
  })
})

describe("runtime: timeout give-up", () => {
  it("retries once then gives up instead of hanging", () => {
    const { rt, logs } = boot({ handoffTimeoutMs: 1000 })
    noteAssistantUsage(rt, { input: 400, output: 10, totalTokens: 410 })
    refreshOccupancy(rt)
    considerTrigger(rt)
    assert.ok(rt.pending)
    rt.pending.startedAt = Date.now() - 5000
    maybeTimeout(rt, Date.now())
    assert.equal(count(logs, "handoff-retry"), 1)
    assert.equal(rt.state.phase, "injecting")
    assert.ok(rt.pending)
    rt.pending.startedAt = Date.now() - 5000
    maybeTimeout(rt, Date.now())
    assert.equal(count(logs, "handoff-give-up"), 1)
    assert.equal(rt.pending, null)
    assert.equal(rt.state.phase, "monitoring")
  })
})

describe("runtime: session_start restore", () => {
  it("recovers preClearIds from a marked continuation in the durable branch", () => {
    const { rt, logs } = boot()
    const entries = [
      { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "original task" }] } },
      { type: "message", message: { role: "assistant", timestamp: 2, model: "m", content: [{ type: "text", text: "wrote handoff" }] } },
      { type: "message", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "continue\n<!-- pi-auto-handoff-continuation n=1 -->" }] } },
      { type: "message", message: { role: "assistant", timestamp: 4, model: "m", content: [{ type: "text", text: "post-continuation step" }] } },
    ]
    rt.hooks.readBranchEntries = () => entries
    const restored = restoreFromBranch(rt)
    assert.equal(restored, true)
    assert.equal(rt.state.phase, "monitoring")
    assert.equal(rt.state.lastHandoffNumber, 1)
    assert.equal(rt.cycle.phase, "filtering")
    assert.equal(rt.cycle.preClearIds?.size, 3)
    assert.equal(count(logs, "session-restored"), 1)

    // the next context event filters instead of re-clearing
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "original task" }] },
      { role: "assistant", timestamp: 2, model: "m", content: [{ type: "text", text: "wrote handoff" }] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "continue\n<!-- pi-auto-handoff-continuation n=1 -->" }] },
      { role: "assistant", timestamp: 4, model: "m", content: [{ type: "text", text: "post-continuation step" }] },
    ]
    applyContextTransform(rt, messages)
    // pre-threshold (0.0001 vs ratio 0) → no new handoff; filter keeps post-marker msgs
    assert.equal(messages.length, 2)
    assert.match(String((messages[0]?.content as { text: string }[])[0]?.text), /continuation/)
  })

  it("no marker: cold start, nothing restored", () => {
    const { rt, logs } = boot()
    rt.hooks.readBranchEntries = () => [
      { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "hi" }] } },
    ]
    assert.equal(restoreFromBranch(rt), false)
    assert.equal(count(logs, "session-restored"), 0)
  })
})
