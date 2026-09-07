import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { envOverrides, mergeConfigSources, type PluginConfig } from "./config.ts"
import type { AgentMessageLike } from "./messages.ts"
import {
  applyContextTransform,
  considerTrigger,
  createRuntime,
  noteAssistantUsage,
  noteToolEnd,
  noteToolStart,
  onUserMessage,
  refreshOccupancy,
  renderedHandoffPrompt,
  runIdlePlan,
  statusSnapshot,
  type Runtime,
} from "./runtime.ts"
import type { PiTokenUsage } from "./usage.ts"

const CONFIG_FILES = [".pi/auto-handoff.json", ".pi/auto-handoff.local.json"]

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function loadConfig(cwd: string): PluginConfig {
  const fileLayers = CONFIG_FILES.map((rel) => readJsonObject(join(cwd, rel)))
  return mergeConfigSources(...fileLayers, envOverrides())
}

function usageFromAssistant(message: {
  role: string
  usage?: PiTokenUsage
  stopReason?: string
}): PiTokenUsage | null {
  if (message.role !== "assistant") return null
  const usage = message.usage
  if (!usage) return null
  return {
    input: usage.input,
    output: usage.output,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  }
}

function bindRuntime(pi: ExtensionAPI, ctx: ExtensionContext, existing: Runtime | null): Runtime {
  if (existing && existing.directory === ctx.cwd) {
    existing.hooks.sendUserMessage = (text) => {
      pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" })
    }
    existing.hooks.getContextUsage = () => ctx.getContextUsage()
    existing.hooks.getModelContextWindow = () => ctx.model?.contextWindow
    existing.hooks.sessionId = () => ctx.sessionManager.getSessionId()
    existing.sessionID = ctx.sessionManager.getSessionId()
    return existing
  }
  return createRuntime({
    cfg: loadConfig(ctx.cwd),
    directory: ctx.cwd,
    hooks: {
      sendUserMessage: (text) => {
        pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" })
      },
      getContextUsage: () => ctx.getContextUsage(),
      getModelContextWindow: () => ctx.model?.contextWindow,
      sessionId: () => ctx.sessionManager.getSessionId(),
    },
  })
}

export default function autoHandoffExtension(pi: ExtensionAPI): void {
  let rt: Runtime | null = null

  const runtime = (ctx: ExtensionContext): Runtime => {
    rt = bindRuntime(pi, ctx, rt)
    return rt
  }

  pi.on("session_start", (_event, ctx) => {
    runtime(ctx)
  })

  pi.on("message_end", (event, ctx) => {
    const current = runtime(ctx)
    if (event.message.role === "assistant") {
      const stop = "stopReason" in event.message ? event.message.stopReason : undefined
      const completed = stop !== "aborted" && stop !== "error"
      noteAssistantUsage(current, usageFromAssistant(event.message), false)
      if (completed) refreshOccupancy(current)
    }
    if (event.message.role === "user") {
      onUserMessage(current, event.message as AgentMessageLike)
    }
  })

  pi.on("turn_end", (_event, ctx) => {
    const current = runtime(ctx)
    noteAssistantUsage(current, current.lastUsage, true)
    refreshOccupancy(current)
    considerTrigger(current)
  })

  pi.on("tool_execution_start", (_event, ctx) => {
    noteToolStart(runtime(ctx))
  })

  pi.on("tool_execution_end", (_event, ctx) => {
    const current = runtime(ctx)
    noteToolEnd(current)
  })

  pi.on("before_agent_start", (event, ctx) => {
    const current = runtime(ctx)
    refreshOccupancy(current)
    considerTrigger(current)
    const extra = renderedHandoffPrompt(current)
    if (!extra) return
    return { systemPrompt: `${event.systemPrompt}\n\n<!-- pi-auto-handoff -->\n${extra}` }
  })

  pi.on("context", (event, ctx) => {
    const current = runtime(ctx)
    const messages = event.messages as AgentMessageLike[]
    applyContextTransform(current, messages)
    return { messages: event.messages }
  })

  pi.on("agent_end", (_event, ctx) => {
    const current = runtime(ctx)
    refreshOccupancy(current)
    considerTrigger(current)
    runIdlePlan(current)
  })

  pi.registerCommand("auto-handoff", {
    description: "Show pi-auto-handoff status",
    handler: async (_args, ctx) => {
      const snap = statusSnapshot(runtime(ctx))
      const text = JSON.stringify(snap, null, 2)
      if (ctx.hasUI) ctx.ui.notify(text, "info")
      else process.stderr.write(`${text}\n`)
    },
  })
}
