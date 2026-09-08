export type PluginConfig = {
  enabled: boolean
  contextThreshold: number
  assumedContextLimit: number
  handoffDir: string
  planFile: string
  handoffPromptFile: string
  continuationPromptFile: string
  continuationPrompt: string
  logging: boolean
  handoffTimeoutMs: number
  logFile: string
}

export const DEFAULTS: PluginConfig = {
  enabled: true,
  contextThreshold: 0.5,
  assumedContextLimit: 200_000,
  handoffDir: ".pi/handoff",
  planFile: ".pi/plan/active-plan.md",
  handoffPromptFile: "",
  continuationPromptFile: "",
  continuationPrompt: "",
  logging: true,
  handoffTimeoutMs: 90_000,
  logFile: "",
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

function str(value: unknown, fallback: string): string {
  if (typeof value === "string") return value
  return fallback
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** Flatten env `PI_AUTO_HANDOFF_*` keys into the same shape as a JSON config object. */
export function envOverrides(env: NodeJS.Dict<string> = process.env): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const map: Record<string, string> = {
    PI_AUTO_HANDOFF_ENABLED: "enabled",
    PI_AUTO_HANDOFF_CONTEXT_THRESHOLD: "contextThreshold",
    PI_AUTO_HANDOFF_ASSUMED_CONTEXT_LIMIT: "assumedContextLimit",
    PI_AUTO_HANDOFF_HANDOFF_DIR: "handoffDir",
    PI_AUTO_HANDOFF_PLAN_FILE: "planFile",
    PI_AUTO_HANDOFF_HANDOFF_PROMPT_FILE: "handoffPromptFile",
    PI_AUTO_HANDOFF_CONTINUATION_PROMPT_FILE: "continuationPromptFile",
    PI_AUTO_HANDOFF_CONTINUATION_PROMPT: "continuationPrompt",
    PI_AUTO_HANDOFF_LOGGING: "logging",
    PI_AUTO_HANDOFF_TIMEOUT_MS: "handoffTimeoutMs",
    PI_AUTO_HANDOFF_LOG_FILE: "logFile",
  }
  for (const [envKey, field] of Object.entries(map)) {
    const value = env[envKey]
    if (value !== undefined && value !== "") out[field] = value
  }
  return out
}

export function parseConfig(options: Record<string, unknown> | null | undefined): PluginConfig {
  const src = options ?? {}
  return {
    enabled: bool(src.enabled, DEFAULTS.enabled),
    contextThreshold: clamp01(num(src.contextThreshold, DEFAULTS.contextThreshold)),
    assumedContextLimit: Math.max(1, Math.floor(num(src.assumedContextLimit, DEFAULTS.assumedContextLimit))),
    handoffDir: str(src.handoffDir, DEFAULTS.handoffDir),
    planFile: str(src.planFile, DEFAULTS.planFile),
    handoffPromptFile: str(src.handoffPromptFile, DEFAULTS.handoffPromptFile),
    continuationPromptFile: str(src.continuationPromptFile, DEFAULTS.continuationPromptFile),
    continuationPrompt: str(src.continuationPrompt, DEFAULTS.continuationPrompt),
    logging: bool(src.logging, DEFAULTS.logging),
    handoffTimeoutMs: Math.max(1_000, Math.floor(num(src.handoffTimeoutMs, DEFAULTS.handoffTimeoutMs))),
    logFile: str(src.logFile, DEFAULTS.logFile),
  }
}

export function mergeConfigSources(
  ...layers: Array<Record<string, unknown> | null | undefined>
): PluginConfig {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value
    }
  }
  return parseConfig(merged)
}
