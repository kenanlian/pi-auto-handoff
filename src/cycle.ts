export type CyclePhase = "monitoring" | "handoff-requested" | "written" | "filtering"

export type TransformPlan =
  | { kind: "none" }
  | { kind: "first-clear"; continuationText: string; logCleared: boolean }
  | { kind: "filter-since"; preClearIds: ReadonlySet<string>; continuationText: string; logCleared: false }
  | { kind: "filter-cursor"; keepFromId: string; logCleared: boolean }

export type IdlePlan =
  | { kind: "none" }
  | { kind: "prompt-handoff" }
  | { kind: "prompt-continuation"; continuationText: string }

export type HandoffCycle = {
  phase: CyclePhase
  pendingNumber: number | null
  completedNumbers: Set<number>
  continuationText: string
  preClearIds: Set<string> | null
  keepFromId: string | null
  firstClearLogged: boolean
  continuationLogged: boolean
  persistDone: boolean
}

export function createCycle(): HandoffCycle {
  return {
    phase: "monitoring",
    pendingNumber: null,
    completedNumbers: new Set(),
    continuationText: "",
    preClearIds: null,
    keepFromId: null,
    firstClearLogged: false,
    continuationLogged: false,
    persistDone: false,
  }
}

export function requestHandoff(cycle: HandoffCycle, number: number): boolean {
  if (cycle.phase === "handoff-requested" || cycle.phase === "written") return false
  if (cycle.completedNumbers.has(number)) return false
  cycle.phase = "handoff-requested"
  cycle.pendingNumber = number
  return true
}

/** File on disk. Must be idempotent per handoff number. Does not enable per-step last-user wipe. */
export function markWritten(cycle: HandoffCycle, number: number, continuationText: string): boolean {
  if (cycle.completedNumbers.has(number)) return false
  if (cycle.pendingNumber !== number && cycle.phase !== "handoff-requested") return false
  cycle.completedNumbers.add(number)
  cycle.pendingNumber = number
  cycle.continuationText = continuationText
  cycle.phase = "written"
  cycle.preClearIds = null
  cycle.keepFromId = null
  cycle.firstClearLogged = false
  cycle.continuationLogged = false
  cycle.persistDone = false
  return true
}

export function decideTransform(cycle: HandoffCycle): TransformPlan {
  if (cycle.phase === "written") {
    return {
      kind: "first-clear",
      continuationText: cycle.continuationText,
      logCleared: !cycle.firstClearLogged,
    }
  }
  if (cycle.keepFromId) {
    return {
      kind: "filter-cursor",
      keepFromId: cycle.keepFromId,
      logCleared: !cycle.firstClearLogged,
    }
  }
  if (cycle.preClearIds) {
    return {
      kind: "filter-since",
      preClearIds: cycle.preClearIds,
      continuationText: cycle.continuationText,
      logCleared: false,
    }
  }
  return { kind: "none" }
}

export function noteFirstClear(cycle: HandoffCycle, messageIds: string[]): void {
  cycle.preClearIds = new Set(messageIds.filter(Boolean))
  cycle.phase = "filtering"
  cycle.firstClearLogged = true
}

export function noteCursor(cycle: HandoffCycle, keepFromId: string): void {
  cycle.keepFromId = keepFromId
  cycle.phase = "filtering"
}

export function noteClearedLogged(cycle: HandoffCycle): void {
  cycle.firstClearLogged = true
}

export function decideIdle(cycle: HandoffCycle): IdlePlan {
  if (cycle.phase === "handoff-requested") return { kind: "prompt-handoff" }
  if (cycle.phase === "written" && !cycle.keepFromId && !cycle.preClearIds && !cycle.persistDone) {
    return { kind: "prompt-continuation", continuationText: cycle.continuationText }
  }
  return { kind: "none" }
}

export function noteContinuationPrompted(cycle: HandoffCycle, userMessageId: string): void {
  cycle.keepFromId = userMessageId
  cycle.phase = "filtering"
  cycle.persistDone = true
  cycle.continuationLogged = true
}

export function notePersisted(cycle: HandoffCycle): void {
  cycle.persistDone = true
  cycle.continuationLogged = true
}

export function injectHandoffSystem(cycle: HandoffCycle): boolean {
  return cycle.phase === "handoff-requested"
}
