import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  continuationMarker,
  injectKey,
  messageKey,
} from "../src/messages.ts"

describe("messages: v2 helpers", () => {
  it("injectKey is fixed and stable per handoff number", () => {
    assert.equal(injectKey(1), "handoff-inject:1")
    assert.equal(injectKey(1), injectKey(1))
    assert.notEqual(injectKey(1), injectKey(2))
    assert.ok(!injectKey(3).includes(String(Date.now())))
  })

  it("parses the continuation marker and its number", () => {
    assert.equal(continuationMarker("resume\n<!-- pi-auto-handoff-continuation n=2 -->"), 2)
    assert.equal(continuationMarker("<!-- pi-auto-handoff-continuation n=7 -->"), 7)
    assert.equal(continuationMarker("<!-- pi-auto-handoff-continuation n=abc -->"), null)
    assert.equal(continuationMarker("no marker here"), null)
  })

  it("messageKey is deterministic for synthetic messages", () => {
    const a = {
      role: "user",
      timestamp: 0,
      content: [{ type: "text", text: "directive" }],
    }
    assert.equal(messageKey(a), messageKey({ ...a }))
  })
})
