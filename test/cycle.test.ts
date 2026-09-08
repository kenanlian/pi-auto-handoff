import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createCycle,
  decideIdle,
  decideTransform,
  markWritten,
  noteFirstClear,
  notePersisted,
  requestHandoff,
} from "../src/cycle.ts"
import { applyClear, applyFilterSince, idsOf, type AgentMessageLike } from "../src/messages.ts"

function msg(role: string, timestamp: number, text = ""): AgentMessageLike {
  if (role === "assistant") return { role, timestamp, model: "m", content: [{ type: "text", text }] }
  return { role, timestamp, content: [{ type: "text", text }] }
}

describe("markWritten", () => {
  it("is idempotent per handoff number", () => {
    const cycle = createCycle()
    assert.equal(requestHandoff(cycle, 1), true)
    assert.equal(markWritten(cycle, 1, "continue WP-2"), true)
    assert.equal(markWritten(cycle, 1, "continue WP-2 again"), false)
    assert.equal(cycle.completedNumbers.size, 1)
    assert.equal(cycle.phase, "written")
  })
})

describe("clearing cycle: first-clear then filter-since", () => {
  it("clears once then keeps post-clear messages", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    assert.equal(markWritten(cycle, 1, "Resume from WP-2. Do not rewrite the handoff."), true)

    const history = [msg("user", 1, "original task"), msg("assistant", 2, "did WP-1"), msg("assistant", 3, "wrote handoff")]

    const first = decideTransform(cycle)
    assert.equal(first.kind, "first-clear")
    if (first.kind !== "first-clear") return
    assert.equal(first.logCleared, true)
    const before = idsOf(history)
    const cleared = applyClear(history, { replacementText: first.continuationText })
    noteFirstClear(cycle, before)
    assert.equal(cleared.mode, "last-user")
    assert.equal(history.length, 1)
    assert.match(String((history[0]?.content as { text: string }[])[0]?.text), /WP-2/)

    assert.equal(decideIdle(cycle).kind, "none")
    const second = decideTransform(cycle)
    assert.equal(second.kind, "filter-since")
    if (second.kind !== "filter-since") return
    assert.equal(second.logCleared, false)

    const fullAgain = [
      msg("user", 1, "original task"),
      msg("assistant", 2, "did WP-1"),
      msg("assistant", 3, "wrote handoff"),
      msg("assistant", 4, "read handoff"),
      msg("assistant", 5, "start WP-2"),
    ]
    applyFilterSince(fullAgain, second.preClearIds, second.continuationText)
    assert.equal(fullAgain.length, 3)
    assert.match(String((fullAgain[0]?.content as { text: string }[])[0]?.text), /WP-2/)

    const third = decideTransform(cycle)
    assert.equal(third.kind, "filter-since")
  })

  it("does not re-arm first-clear after the snapshot", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    markWritten(cycle, 1, "go")
    noteFirstClear(cycle, ["u:1:old"])
    for (let i = 0; i < 48; i++) {
      const plan = decideTransform(cycle)
      assert.equal(plan.kind, "filter-since")
      if (plan.kind === "filter-since") assert.equal(plan.logCleared, false)
    }
  })

  it("does not send a second continuation after persistDone", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    markWritten(cycle, 1, "continue")
    notePersisted(cycle)
    assert.equal(decideIdle(cycle).kind, "none")
  })
})

describe("requestHandoff after a completed cycle", () => {
  it("allows a later handoff number while still projecting the previous filter", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    markWritten(cycle, 1, "first")
    noteFirstClear(cycle, ["u:1:old"])
    assert.equal(requestHandoff(cycle, 2), true)
    assert.equal(cycle.phase, "handoff-requested")
    const plan = decideTransform(cycle)
    assert.equal(plan.kind, "filter-since")
  })
})
