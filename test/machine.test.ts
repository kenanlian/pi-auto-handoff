import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateTrigger, initialState, reduce } from "../src/machine.ts"

describe("evaluateTrigger (v2 single threshold, context event only)", () => {
  const base = {
    enabled: true,
    ratio: 0.6,
    threshold: 0.5,
    phase: "monitoring" as const,
  }

  it("fires when ratio meets threshold while monitoring", () => {
    assert.equal(evaluateTrigger(base), true)
  })

  it("does not fire below threshold", () => {
    assert.equal(evaluateTrigger({ ...base, ratio: 0.49 }), false)
  })

  it("fires at exactly the threshold", () => {
    assert.equal(evaluateTrigger({ ...base, ratio: 0.5 }), true)
  })

  it("does not fire when disabled", () => {
    assert.equal(evaluateTrigger({ ...base, enabled: false }), false)
  })

  it("does not re-enter while injecting or written", () => {
    assert.equal(evaluateTrigger({ ...base, phase: "injecting" }), false)
    assert.equal(evaluateTrigger({ ...base, phase: "written" }), false)
  })

  it("re-arms after clearing", () => {
    let s = initialState()
    s = reduce(s, { type: "start-monitoring" })
    s = reduce(s, { type: "request-handoff" })
    assert.equal(s.phase, "injecting")
    s = reduce(s, { type: "handoff-written" })
    assert.equal(s.phase, "written")
    s = reduce(s, { type: "cleared" })
    assert.equal(s.phase, "monitoring")
    assert.equal(
      evaluateTrigger({ ...base, phase: s.phase }),
      true,
    )
  })
})

describe("reduce", () => {
  it("retries then gives up without hanging", () => {
    let s = initialState()
    s = reduce(s, { type: "start-monitoring" })
    s = reduce(s, { type: "request-handoff" })
    assert.equal(s.phase, "injecting")
    assert.equal(s.handoffAttempts, 1)
    s = reduce(s, { type: "handoff-retry" })
    assert.equal(s.phase, "injecting")
    assert.equal(s.handoffAttempts, 2)
    s = reduce(s, { type: "handoff-give-up" })
    assert.equal(s.phase, "monitoring")
    assert.equal(s.handoffAttempts, 0)
  })

  it("counts handoff numbers monotonically", () => {
    let s = initialState()
    s = reduce(s, { type: "request-handoff" })
    s = reduce(s, { type: "handoff-written" })
    assert.equal(s.lastHandoffNumber, 1)
    s = reduce(s, { type: "cleared" })
    s = reduce(s, { type: "request-handoff" })
    s = reduce(s, { type: "handoff-written" })
    assert.equal(s.lastHandoffNumber, 2)
  })
})
