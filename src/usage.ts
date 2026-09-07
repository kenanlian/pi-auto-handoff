/**
 * Authoritative token occupancy for Pi.
 *
 * Pi's `ctx.getContextUsage()` uses last-assistant `Usage` via
 * `calculateContextTokens(usage) = usage.totalTokens || input+output+cacheRead+cacheWrite`,
 * plus a trailing-message estimate, divided by `model.contextWindow`.
 * Character-count heuristics are never the primary trigger.
 */

export type PiTokenUsage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
}

export type ContextUsageSnapshot = {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** Same formula Pi uses in `calculateContextTokens`. */
export function contextTokens(usage: PiTokenUsage | null | undefined): number {
  if (!usage) return 0
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens
  return usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

export function occupancy(usage: PiTokenUsage | null | undefined, limit: number): number {
  if (!limit || limit <= 0) return 0
  return contextTokens(usage) / limit
}

export function occupancyFromContextUsage(usage: ContextUsageSnapshot | null | undefined): number {
  if (!usage) return 0
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return usage.percent / 100
  }
  if (typeof usage.tokens === "number" && usage.tokens > 0 && usage.contextWindow > 0) {
    return usage.tokens / usage.contextWindow
  }
  return 0
}

export function hasAuthoritativeUsage(usage: PiTokenUsage | null | undefined): boolean {
  if (!usage) return false
  return contextTokens(usage) > 0
}

export function hasAuthoritativeContextUsage(usage: ContextUsageSnapshot | null | undefined): boolean {
  if (!usage) return false
  if (usage.contextWindow <= 0) return false
  return (typeof usage.tokens === "number" && usage.tokens > 0) || (typeof usage.percent === "number" && usage.percent > 0)
}
