import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PluginConfig } from "./config.ts"
import {
  createCycle,
  decideIdle,
  decideTransform,
  markWritten,
  noteClearedLogged,
  noteContinuationPrompted,
  noteCursor,
  noteFirstClear,
  notePersisted,
  requestHandoff as cycleRequest,
  type HandoffCycle,
} from "./cycle.ts"
import { createLogger, type Logger } from "./log.ts"
import {
  applyClear,
  applyFilterSince,
  continuationMarker,
  idsOf,
  injectKey,
  messageKey,
  verifyHandoffBody,
  type AgentMessageLike,
} from "./messages.ts"
import { evaluateTrigger, initialState, reduce, type MachineState } from "./machine.ts"
import { abs, eventsLogPath, nextHandoffPath } from "./paths.ts"
import { bundledContinuationPrompt, bundledHandoffPrompt, loadText, render } from "./templates.ts"
import {
  hasAuthoritativeContextUsage,
  hasAuthoritativeUsage,
  occupancy,
  occupancyFromContextUsage,
  type ContextUsageSnapshot,
  type PiTokenUsage,
} from "./usage.ts"

export type PendingHandoff = {
  path: string
  number: number
  startedAt: number
  attempt: number
}

export type SendUserMessage = (text: string) => void

export type RuntimeHooks = {
  sendUserMessage: SendUserMessage
  getContextUsage?: () => ContextUsageSnapshot | undefined
  getModelContextWindow?: () => number | undefined
  sessionId?: () => string | undefined
  readBranchEntries?: () => Array<Record<string, unknown>> | undefined
}

export type Runtime = {
  cfg: PluginConfig
  directory: string
  log: Logger
  state: MachineState
  cycle: HandoffCycle
  sessionID?: string
  limit: number
  limitWarned: boolean
  lastUsage: PiTokenUsage | null
  lastRatio: number
  inFlightTools: number
  pending: PendingHandoff | null
  injecting: boolean
  injectCount: number
  /** After a clear/restore, distrust stale getContextUsage until a fresh assistant usage arrives. */
  awaitingFreshUsage: boolean
  /**
   * Re-arm guard: after a clear, a new handoff fires only once an authoritative
   * ratio has been observed BELOW the threshold again (context genuinely
   * regrown past it). Cold start begins armed.
   */
  armed: boolean
  handoffPrompt: string
  continuationTemplate: string
  hooks: RuntimeHooks
}

function loadPrompts(cfg: PluginConfig, directory: string): { handoff: string; continuation: string } {
  const handoff = cfg.handoffPromptFile
    ? loadText(abs(directory, cfg.handoffPromptFile), "handoff-prompt.md")
    : bundledHandoffPrompt()
  const continuation = cfg.continuationPrompt
    ? cfg.continuationPrompt
    : cfg.continuationPromptFile
      ? loadText(abs(directory, cfg.continuationPromptFile), "continuation-prompt.md")
      : bundledContinuationPrompt()
  return { handoff, continuation }
}

export function handoffVars(rt: Runtime, pending: PendingHandoff): Record<string, string> {
  return {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    handoffNumber: String(pending.number),
    timestamp: new Date(pending.startedAt).toISOString(),
    reason: "context-threshold",
    ratio: rt.lastRatio.toFixed(3),
    threshold: String(rt.cfg.contextThreshold),
  }
}

export function injectDirective(rt: Runtime, pending: PendingHandoff): string {
  return render(rt.handoffPrompt, handoffVars(rt, pending))
}

function continuationFor(rt: Runtime, pending: PendingHandoff): string {
  return render(rt.continuationTemplate, {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    handoffNumber: String(pending.number),
    handoffBody: existsSync(pending.path) ? readFileSync(pending.path, "utf8") : "(handoff file missing)",
    continuationNumber: String(pending.number),
  })
}

function writeEventFile(rt: Runtime, level: string, message: string, extra?: Record<string, unknown>): void {
  const payload = JSON.stringify({
    channel: "pi-auto-handoff",
    ts: new Date().toISOString(),
    level,
    message,
    extra: extra ?? {},
  })
  try {
    const events = eventsLogPath(rt.cfg.handoffDir, rt.directory)
    appendFileSync(events, `${payload}\n`)
  } catch {
    // ignore sidecar write failures
  }
  if (rt.cfg.logFile) {
    try {
      mkdirSync(dirname(abs(rt.directory, rt.cfg.logFile)), { recursive: true })
      appendFileSync(abs(rt.directory, rt.cfg.logFile), `${payload}\n`)
    } catch {
      // ignore
    }
  }
}

function scanContinuationMarker(rt: Runtime): { n: number; ids: string[]; markerText: string } | null {
  const read = rt.hooks.readBranchEntries
  if (!read) return null
  let entries: Array<Record<string, unknown>> | undefined
  try {
    entries = read()
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  // Locate the newest continuation marker and snapshot every message id at or before it.
  let markerIndex = -1
  let n = 0
  let markerText = ""
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const message = entry?.message as AgentMessageLike | undefined
    if (!message || message.role !== "user") continue
    const text = textOfMessage(message)
    const found = continuationMarker(text)
    if (found) {
      markerIndex = i
      n = found
      markerText = text
      break
    }
  }
  if (markerIndex < 0) return null
  const ids: string[] = []
  for (let i = 0; i <= markerIndex; i++) {
    const message = entries[i]?.message as AgentMessageLike | undefined
    if (message && typeof message.role === "string") ids.push(messageKey(message))
  }
  return { n, ids, markerText }
}

function textOfMessage(message: AgentMessageLike): string {
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join("\n")
}

export function createRuntime(input: {
  cfg: PluginConfig
  directory: string
  hooks: RuntimeHooks
}): Runtime {
  const prompts = loadPrompts(input.cfg, input.directory)
  const rt: Runtime = {
    cfg: input.cfg,
    directory: input.directory,
    log: createLogger({
      enabled: input.cfg.logging,
      write: (level, message, extra) => {
        const line = JSON.stringify({
          channel: "pi-auto-handoff",
          level,
          message,
          extra: extra ?? {},
        })
        process.stderr.write(`${line}\n`)
        writeEventFile(rt, level, message, extra)
      },
    }),
    state: initialState(),
    cycle: createCycle(),
    limit: input.cfg.assumedContextLimit,
    limitWarned: false,
    lastUsage: null,
    lastRatio: 0,
    inFlightTools: 0,
    pending: null,
    injecting: false,
    injectCount: 0,
    awaitingFreshUsage: false,
    armed: true,
    handoffPrompt: prompts.handoff,
    continuationTemplate: prompts.continuation,
    hooks: input.hooks,
  }
  rt.state = reduce(rt.state, { type: "start-monitoring" })
  rt.log.log("info", "plugin-loaded", {
    enabled: rt.cfg.enabled,
    contextThreshold: rt.cfg.contextThreshold,
    handoffDir: rt.cfg.handoffDir,
    planFile: rt.cfg.planFile,
    assumedContextLimit: rt.cfg.assumedContextLimit,
  })
  return rt
}

export function requestHandoff(rt: Runtime): void {
  const n = rt.state.lastHandoffNumber + 1
  if (!cycleRequest(rt.cycle, n)) return
  const path = nextHandoffPath(rt.cfg.handoffDir, rt.directory, n)
  rt.pending = { path, number: n, startedAt: Date.now(), attempt: 1 }
  rt.state = reduce(rt.state, { type: "request-handoff" })
  rt.log.log("info", "handoff-requested", {
    phase: rt.state.phase,
    path,
    number: n,
    ratio: rt.lastRatio,
    sessionID: rt.sessionID ?? rt.hooks.sessionId?.(),
  })
}

export function verifyHandoffFile(rt: Runtime): boolean {
  if (!rt.pending) return false
  if (!existsSync(rt.pending.path)) return false
  return verifyHandoffBody(readFileSync(rt.pending.path, "utf8"))
}

export function onHandoffVerified(rt: Runtime): void {
  if (!rt.pending) return
  const cont = continuationFor(rt, rt.pending)
  if (!markWritten(rt.cycle, rt.pending.number, cont)) return
  rt.lastRatio = 0
  rt.lastUsage = null
  rt.state = reduce(rt.state, { type: "handoff-written" })
  rt.log.log("info", "handoff-written", { path: rt.pending.path, number: rt.pending.number })
}

export function maybeTimeout(rt: Runtime, now: number): void {
  if (!rt.pending || rt.state.phase !== "injecting") return
  if (now - rt.pending.startedAt < rt.cfg.handoffTimeoutMs) return
  if (rt.pending.attempt < 2) {
    rt.pending.attempt += 1
    rt.pending.startedAt = now
    rt.state = reduce(rt.state, { type: "handoff-retry" })
    rt.log.log("warn", "handoff-retry", { attempt: rt.pending.attempt, path: rt.pending.path })
    return
  }
  rt.log.log("error", "handoff-give-up", { path: rt.pending.path, attempts: rt.pending.attempt })
  rt.pending = null
  rt.state = reduce(rt.state, { type: "handoff-give-up" })
}

export function refreshOccupancy(rt: Runtime): void {
  const window = rt.hooks.getModelContextWindow?.()
  if (typeof window === "number" && window > 0) {
    rt.limit = window
  } else if (!rt.limitWarned) {
    rt.limitWarned = true
    rt.log.log("warn", "assumed-context-limit", { assumedContextLimit: rt.cfg.assumedContextLimit })
  }

  if (rt.awaitingFreshUsage) return

  const ctxUsage = rt.hooks.getContextUsage?.()
  if (hasAuthoritativeContextUsage(ctxUsage)) {
    rt.lastRatio = occupancyFromContextUsage(ctxUsage)
    if (rt.lastRatio < rt.cfg.contextThreshold) rt.armed = true
    if (typeof ctxUsage?.tokens === "number") {
      rt.log.log("debug", "usage", {
        contextTokens: ctxUsage.tokens,
        limit: ctxUsage.contextWindow,
        ratio: rt.lastRatio,
        source: "getContextUsage",
      })
    }
    return
  }
  if (hasAuthoritativeUsage(rt.lastUsage) && rt.limit > 0) {
    rt.lastRatio = occupancy(rt.lastUsage, rt.limit)
    if (rt.lastRatio < rt.cfg.contextThreshold) rt.armed = true
    rt.log.log("debug", "usage", {
      contextTokens: rt.lastUsage ? rt.lastUsage.input + rt.lastUsage.output + (rt.lastUsage.cacheRead ?? 0) + (rt.lastUsage.cacheWrite ?? 0) : 0,
      limit: rt.limit,
      ratio: rt.lastRatio,
      source: "assistant-usage",
    })
  }
}

/**
 * v2 trigger point: the `context` event (fired before every LLM call).
 * Threshold breach while monitoring → request handoff, then inject the directive
 * into this very call's message array (mid-run; no run boundary needed).
 */
export function applyContextTransform(rt: Runtime, messages: AgentMessageLike[]): {
  messages: AgentMessageLike[]
  injected: boolean
} {
  refreshOccupancy(rt)
  considerTrigger(rt)
  let injected = false
  if (rt.pending && rt.state.phase === "injecting") {
    const directive = injectDirective(rt, rt.pending)
    if (directive) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: directive }],
        timestamp: 0,
      })
      rt.injectCount += 1
      injected = true
      rt.log.log("info", "handoff-injected", {
        key: injectKey(rt.pending.number),
        number: rt.pending.number,
        path: rt.pending.path,
        ratio: rt.lastRatio,
        sessionID: rt.sessionID ?? rt.hooks.sessionId?.(),
      })
    }
  }
  const plan = decideTransform(rt.cycle)
  if (plan.kind === "first-clear") {
    const before = idsOf(messages)
    const result = applyClear(messages, { replacementText: plan.continuationText })
    noteFirstClear(rt.cycle, before)
    rt.state = reduce(rt.state, { type: "cleared" })
    rt.pending = null
    rt.awaitingFreshUsage = true
    rt.lastRatio = 0
    rt.armed = false
    if (plan.logCleared) {
      rt.log.log("info", "clearing", {
        sessionID: rt.sessionID ?? rt.hooks.sessionId?.(),
        mode: result.mode,
        before: before.length,
        after: messages.length,
      })
      rt.log.log("info", "messages-cleared", { ...result, before: before.length, after: messages.length })
      rt.log.log("info", "continuation-projected", {
        sessionID: rt.sessionID ?? rt.hooks.sessionId?.(),
        via: "context",
        before: before.length,
        after: messages.length,
      })
    }
    return { messages, injected }
  }
  if (plan.kind === "filter-since") {
    applyFilterSince(messages, plan.preClearIds, plan.continuationText)
    return { messages, injected }
  }
  if (plan.kind === "filter-cursor") {
    const result = applyClear(messages, { keepFromId: plan.keepFromId })
    if (plan.logCleared) {
      noteClearedLogged(rt.cycle)
      noteCursor(rt.cycle, plan.keepFromId)
      rt.state = reduce(rt.state, { type: "cleared" })
      rt.log.log("info", "clearing", { sessionID: rt.sessionID ?? rt.hooks.sessionId?.(), keepFromId: plan.keepFromId })
      rt.log.log("info", "messages-cleared", result)
    }
  }
  return { messages, injected }
}

export function considerTrigger(rt: Runtime): void {
  if (rt.inFlightTools > 0) return
  if (rt.pending) {
    if (verifyHandoffFile(rt)) onHandoffVerified(rt)
    else maybeTimeout(rt, Date.now())
    return
  }
  if (!rt.armed) return
  if (!evaluateTrigger({ enabled: rt.cfg.enabled, ratio: rt.lastRatio, threshold: rt.cfg.contextThreshold, phase: rt.state.phase })) {
    return
  }
  rt.armed = false
  requestHandoff(rt)
}

export function noteAssistantUsage(rt: Runtime, usage: PiTokenUsage | null | undefined): void {
  if (hasAuthoritativeUsage(usage)) {
    rt.lastUsage = usage ?? null
    rt.awaitingFreshUsage = false
  }
}

export function noteToolStart(rt: Runtime): void {
  rt.inFlightTools += 1
}

export function noteToolEnd(rt: Runtime): void {
  rt.inFlightTools = Math.max(0, rt.inFlightTools - 1)
  if (rt.pending && verifyHandoffFile(rt)) onHandoffVerified(rt)
}

export function onUserMessage(rt: Runtime, message: AgentMessageLike): void {
  if (message.role !== "user") return
  if (rt.cycle.phase !== "written" && rt.cycle.phase !== "filtering") return
  if (!rt.cycle.continuationText) return
  noteContinuationPrompted(rt.cycle, messageKey(message))
  if (rt.state.phase !== "monitoring") {
    rt.state = reduce(rt.state, { type: "cleared" })
  }
  rt.pending = null
}

/**
 * Only remaining agent_end duty: when the handoff file is already written and the
 * model has stopped, relight the same session via a real user message (JSONL).
 */
export function runIdlePlan(rt: Runtime): "continuation" | "none" {
  if (rt.injecting) return "none"
  if (rt.inFlightTools > 0) return "none"
  if (rt.pending && rt.state.phase === "injecting") {
    if (!verifyHandoffFile(rt)) {
      maybeTimeout(rt, Date.now())
      return "none"
    }
    onHandoffVerified(rt)
  }
  rt.injecting = true
  try {
    const plan = decideIdle(rt.cycle)
    if (plan.kind !== "prompt-continuation") return "none"
    rt.state = reduce(rt.state, { type: "cleared" })
    rt.log.log("info", "clearing", { sessionID: rt.sessionID ?? rt.hooks.sessionId?.(), via: "sendUserMessage" })
    rt.log.log("info", "messages-cleared", { kept: 1, mode: "prompt" })
    noteClearedLogged(rt.cycle)
    rt.log.log("info", "continuation-injected", {
      sessionID: rt.sessionID ?? rt.hooks.sessionId?.(),
      via: "prompt",
    })
    rt.hooks.sendUserMessage(plan.continuationText)
    notePersisted(rt.cycle)
    rt.state = reduce(rt.state, { type: "cleared" })
    rt.pending = null
    rt.awaitingFreshUsage = true
    rt.lastRatio = 0
    rt.armed = false
    return "continuation"
  } finally {
    rt.injecting = false
  }
}

/** session_start restore: same --session-id restart pre-populates the cycle from the durable branch. */
export function restoreFromBranch(rt: Runtime): boolean {
  const found = scanContinuationMarker(rt)
  if (!found) return false
  rt.state = reduce(rt.state, { type: "cleared" })
  rt.state.lastHandoffNumber = Math.max(rt.state.lastHandoffNumber, found.n)
  if (cycleRequest(rt.cycle, found.n)) {
    markWritten(rt.cycle, found.n, found.markerText)
  }
  rt.cycle.preClearIds = new Set(found.ids)
  rt.cycle.phase = "filtering"
  rt.awaitingFreshUsage = true
  rt.lastRatio = 0
  rt.armed = false
  rt.log.log("info", "session-restored", { n: found.n, preClearCount: found.ids.length })
  return true
}

export function statusSnapshot(rt: Runtime): Record<string, unknown> {
  return {
    enabled: rt.cfg.enabled,
    phase: rt.state.phase,
    cycle: rt.cycle.phase,
    ratio: rt.lastRatio,
    threshold: rt.cfg.contextThreshold,
    inFlightTools: rt.inFlightTools,
    pending: rt.pending?.path ?? null,
    sessionID: rt.sessionID ?? rt.hooks.sessionId?.() ?? null,
    injectCount: rt.injectCount,
  }
}
