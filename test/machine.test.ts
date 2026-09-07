import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateTrigger, initialState, reduce } from "../src/machine.ts"

describe("evaluateTrigger", () => {
  const base = {
    enabled: true,
    ratio: 0.6,
    threshold: 0.5,
    hardCeiling: 0.75,
    wpBoundary: true,
    turnsSinceHandoff: 3,
    minTurnsBetweenHandoffs: 3,
    phase: "monitoring" as const,
  }

  it("fires on threshold AND wp boundary", () => {
    assert.equal(evaluateTrigger(base), "threshold-wp")
  })

  it("does not fire when threshold unmet even at wp boundary", () => {
    assert.equal(evaluateTrigger({ ...base, ratio: 0.4 }), null)
  })

  it("does not fire over threshold without wp boundary", () => {
    assert.equal(evaluateTrigger({ ...base, wpBoundary: false }), null)
  })

  it("fires hard-ceiling without wp boundary", () => {
    assert.equal(evaluateTrigger({ ...base, ratio: 0.8, wpBoundary: false }), "hard-ceiling")
  })

  it("prefers hard-ceiling when both match", () => {
    assert.equal(evaluateTrigger({ ...base, ratio: 0.9, wpBoundary: true }), "hard-ceiling")
  })

  it("honors debounce", () => {
    assert.equal(evaluateTrigger({ ...base, turnsSinceHandoff: 2 }), null)
  })

  it("allows trigger when minTurns is 0", () => {
    assert.equal(
      evaluateTrigger({ ...base, turnsSinceHandoff: 0, minTurnsBetweenHandoffs: 0 }),
      "threshold-wp",
    )
  })

  it("does not fire when disabled", () => {
    assert.equal(evaluateTrigger({ ...base, enabled: false }), null)
  })

  it("does not re-enter while handoff is in flight", () => {
    assert.equal(evaluateTrigger({ ...base, phase: "handoff-requested" }), null)
    assert.equal(evaluateTrigger({ ...base, phase: "clearing" }), null)
    assert.equal(evaluateTrigger({ ...base, phase: "cleared" }), null)
  })
})

describe("reduce", () => {
  it("retries then gives up without hanging", () => {
    let s = initialState()
    s = reduce(s, { type: "start-monitoring" })
    s = reduce(s, { type: "request-handoff", reason: "threshold-wp" })
    assert.equal(s.phase, "handoff-requested")
    assert.equal(s.handoffAttempts, 1)
    s = reduce(s, { type: "handoff-retry" })
    assert.equal(s.phase, "handoff-requested")
    assert.equal(s.handoffAttempts, 2)
    s = reduce(s, { type: "handoff-give-up" })
    assert.equal(s.phase, "monitoring")
    assert.equal(s.handoffAttempts, 0)
  })

  it("counts turns and resets after continuation", () => {
    let s = initialState()
    s = reduce(s, { type: "start-monitoring" })
    s = reduce(s, { type: "turn-completed" })
    s = reduce(s, { type: "turn-completed" })
    assert.equal(s.turnsSinceHandoff, 2)
    s = reduce(s, { type: "request-handoff", reason: "hard-ceiling" })
    s = reduce(s, { type: "handoff-written" })
    s = reduce(s, { type: "cleared" })
    s = reduce(s, { type: "continuation-injected" })
    assert.equal(s.phase, "monitoring")
    assert.equal(s.turnsSinceHandoff, 0)
    assert.equal(s.lastHandoffNumber, 1)
  })
})
