import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PluginConfig } from "./config.ts"
import {
  createCycle,
  decideIdle,
  decideTransform,
  injectHandoffSystem,
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
  idsOf,
  messageKey,
  verifyHandoffBody,
  type AgentMessageLike,
} from "./messages.ts"
import { evaluateTrigger, initialState, reduce, type MachineState, type TriggerReason } from "./machine.ts"
import { abs, eventsLogPath, nextHandoffPath } from "./paths.ts"
import { appendHandoffMarker, newlyCompleted, nextIncomplete, parsePlan, type PlanSnapshot } from "./plan.ts"
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
  reason: TriggerReason
  startedAt: number
  attempt: number
}

export type SendUserMessage = (text: string) => void

export type RuntimeHooks = {
  sendUserMessage: SendUserMessage
  getContextUsage?: () => ContextUsageSnapshot | undefined
  getModelContextWindow?: () => number | undefined
  sessionId?: () => string | undefined
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
  plan: PlanSnapshot | null
  pending: PendingHandoff | null
  injecting: boolean
  handoffPrompt: string
  continuationTemplate: string
  hooks: RuntimeHooks
}

function readPlan(cfg: PluginConfig, directory: string): PlanSnapshot | null {
  const file = abs(directory, cfg.planFile)
  if (!existsSync(file)) return null
  return parsePlan(readFileSync(file, "utf8"))
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
  const hard =
    pending.reason === "hard-ceiling"
      ? "HARD CEILING: finish the current WP, persist plan/state to disk, then write this handoff. Do not start new WPs."
      : ""
  return {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    handoffNumber: String(pending.number),
    timestamp: new Date(pending.startedAt).toISOString(),
    reason: pending.reason,
    hardCeilingNote: hard,
  }
}

export function renderedHandoffPrompt(rt: Runtime): string | null {
  if (!rt.pending || !injectHandoffSystem(rt.cycle)) return null
  return render(rt.handoffPrompt, handoffVars(rt, rt.pending))
}

function markPlan(rt: Runtime, pending: PendingHandoff): void {
  const file = abs(rt.directory, rt.cfg.planFile)
  if (!existsSync(file)) return
  const next = appendHandoffMarker(readFileSync(file, "utf8"), {
    n: pending.number,
    file: pending.path,
    ts: new Date(pending.startedAt).toISOString(),
  })
  writeFileSync(file, next)
}

function continuationFor(rt: Runtime, pending: PendingHandoff): string {
  const next = readPlan(rt.cfg, rt.directory)
  return render(rt.continuationTemplate, {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    nextWp: nextIncomplete(next ?? { packages: [], handoffCount: 0 })?.id ?? "next incomplete WP",
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
    plan: readPlan(input.cfg, input.directory),
    pending: null,
    injecting: false,
    handoffPrompt: prompts.handoff,
    continuationTemplate: prompts.continuation,
    hooks: input.hooks,
  }
  rt.state = reduce(rt.state, { type: "start-monitoring" })
  rt.log.log("info", "plugin-loaded", {
    enabled: rt.cfg.enabled,
    contextThreshold: rt.cfg.contextThreshold,
    hardCeiling: rt.cfg.hardCeiling,
    handoffDir: rt.cfg.handoffDir,
    planFile: rt.cfg.planFile,
    assumedContextLimit: rt.cfg.assumedContextLimit,
  })
  return rt
}

export function requestHandoff(rt: Runtime, reason: TriggerReason): void {
  const plan = readPlan(rt.cfg, rt.directory)
  const n = (plan?.handoffCount ?? rt.state.lastHandoffNumber) + 1
  if (!cycleRequest(rt.cycle, n)) return
  const path = nextHandoffPath(rt.cfg.handoffDir, rt.directory, n)
  rt.pending = { path, number: n, reason, startedAt: Date.now(), attempt: 1 }
  rt.state = reduce(rt.state, { type: "request-handoff", reason })
  rt.log.log("info", "handoff-requested", {
    phase: rt.state.phase,
    reason,
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
  markPlan(rt, rt.pending)
  rt.lastRatio = 0
  rt.lastUsage = null
  rt.state = reduce(rt.state, { type: "handoff-written" })
  rt.log.log("info", "handoff-written", { path: rt.pending.path, number: rt.pending.number })
}

export function maybeTimeout(rt: Runtime, now: number): void {
  if (!rt.pending || rt.state.phase !== "handoff-requested") return
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

  const ctxUsage = rt.hooks.getContextUsage?.()
  if (hasAuthoritativeContextUsage(ctxUsage)) {
    rt.lastRatio = occupancyFromContextUsage(ctxUsage)
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
    rt.log.log("debug", "usage", {
      contextTokens: rt.lastUsage ? rt.lastUsage.input + rt.lastUsage.output + (rt.lastUsage.cacheRead ?? 0) + (rt.lastUsage.cacheWrite ?? 0) : 0,
      limit: rt.limit,
      ratio: rt.lastRatio,
      source: "assistant-usage",
    })
  }
}

export function considerTrigger(rt: Runtime): void {
  if (rt.inFlightTools > 0) return
  if (rt.pending) {
    if (verifyHandoffFile(rt)) onHandoffVerified(rt)
    else maybeTimeout(rt, Date.now())
    return
  }
  const plan = readPlan(rt.cfg, rt.directory)
  const newly = newlyCompleted(rt.plan, plan ?? { packages: [], handoffCount: 0 })
  rt.plan = plan
  const reason = evaluateTrigger({
    enabled: rt.cfg.enabled,
    ratio: rt.lastRatio,
    threshold: rt.cfg.contextThreshold,
    hardCeiling: rt.cfg.hardCeiling,
    wpBoundary: newly.length > 0,
    turnsSinceHandoff: rt.state.turnsSinceHandoff,
    minTurnsBetweenHandoffs: rt.cfg.minTurnsBetweenHandoffs,
    phase: rt.state.phase,
  })
  if (!reason) return
  requestHandoff(rt, reason)
}

export function noteAssistantUsage(rt: Runtime, usage: PiTokenUsage | null | undefined, completed: boolean): void {
  if (hasAuthoritativeUsage(usage)) {
    rt.lastUsage = usage ?? null
  }
  if (completed) {
    rt.state = reduce(rt.state, { type: "turn-completed" })
  }
}

export function noteToolStart(rt: Runtime): void {
  rt.inFlightTools += 1
}

export function noteToolEnd(rt: Runtime): void {
  rt.inFlightTools = Math.max(0, rt.inFlightTools - 1)
  if (rt.pending && verifyHandoffFile(rt)) onHandoffVerified(rt)
}

export function applyContextTransform(rt: Runtime, messages: AgentMessageLike[]): {
  messages: AgentMessageLike[]
  result: ReturnType<typeof applyClear> | ReturnType<typeof applyFilterSince> | null
} {
  considerTrigger(rt)
  const plan = decideTransform(rt.cycle)
  if (plan.kind === "none") return { messages, result: null }
  if (plan.kind === "first-clear") {
    const before = idsOf(messages)
    const result = applyClear(messages, { replacementText: plan.continuationText })
    noteFirstClear(rt.cycle, before)
    rt.state = reduce(rt.state, { type: "cleared" })
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
    return { messages, result }
  }
  if (plan.kind === "filter-since") {
    const result = applyFilterSince(messages, plan.preClearIds, plan.continuationText)
    return { messages, result }
  }
  const result = applyClear(messages, { keepFromId: plan.keepFromId })
  if (plan.logCleared) {
    noteClearedLogged(rt.cycle)
    noteCursor(rt.cycle, plan.keepFromId)
    rt.state = reduce(rt.state, { type: "cleared" })
    rt.log.log("info", "clearing", { sessionID: rt.sessionID ?? rt.hooks.sessionId?.(), keepFromId: plan.keepFromId })
    rt.log.log("info", "messages-cleared", result)
  }
  return { messages, result }
}

export function onUserMessage(rt: Runtime, message: AgentMessageLike): void {
  if (message.role !== "user") return
  if (rt.cycle.phase !== "written" && rt.cycle.phase !== "filtering") return
  if (!rt.cycle.continuationText) return
  noteContinuationPrompted(rt.cycle, messageKey(message))
  if (rt.state.phase !== "monitoring") {
    rt.state = reduce(rt.state, { type: "continuation-injected" })
  }
  rt.pending = null
}

export function runIdlePlan(rt: Runtime): "handoff" | "continuation" | "none" {
  if (rt.injecting) return "none"
  if (rt.inFlightTools > 0) return "none"
  considerTrigger(rt)
  const plan = decideIdle(rt.cycle)
  if (plan.kind === "none") return "none"
  rt.injecting = true
  try {
    if (plan.kind === "prompt-handoff") {
      if (!rt.pending) return "none"
      const text = render(rt.handoffPrompt, handoffVars(rt, rt.pending))
      rt.hooks.sendUserMessage(text)
      return "handoff"
    }
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
    rt.state = reduce(rt.state, { type: "continuation-injected" })
    rt.pending = null
    return "continuation"
  } finally {
    rt.injecting = false
  }
}

export function statusSnapshot(rt: Runtime): Record<string, unknown> {
  return {
    enabled: rt.cfg.enabled,
    phase: rt.state.phase,
    cycle: rt.cycle.phase,
    ratio: rt.lastRatio,
    threshold: rt.cfg.contextThreshold,
    hardCeiling: rt.cfg.hardCeiling,
    inFlightTools: rt.inFlightTools,
    pending: rt.pending?.path ?? null,
    sessionID: rt.sessionID ?? rt.hooks.sessionId?.() ?? null,
    turnsSinceHandoff: rt.state.turnsSinceHandoff,
  }
}
