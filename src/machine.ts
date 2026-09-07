export type Phase =
  | "idle"
  | "monitoring"
  | "handoff-requested"
  | "clearing"
  | "cleared"
  | "continuation-injected"

export type TriggerReason = "threshold-wp" | "hard-ceiling"

export type MachineState = {
  phase: Phase
  lastTrigger: TriggerReason | null
  handoffAttempts: number
  turnsSinceHandoff: number
  lastHandoffNumber: number
}

export type EvaluateInput = {
  enabled: boolean
  ratio: number
  threshold: number
  hardCeiling: number
  wpBoundary: boolean
  turnsSinceHandoff: number
  minTurnsBetweenHandoffs: number
  phase: Phase
}

export function initialState(): MachineState {
  return {
    phase: "idle",
    lastTrigger: null,
    handoffAttempts: 0,
    turnsSinceHandoff: 0,
    lastHandoffNumber: 0,
  }
}

export function evaluateTrigger(input: EvaluateInput): TriggerReason | null {
  if (!input.enabled) return null
  if (input.phase === "handoff-requested" || input.phase === "clearing" || input.phase === "cleared") return null
  if (input.turnsSinceHandoff < input.minTurnsBetweenHandoffs) return null
  if (input.ratio >= input.hardCeiling) return "hard-ceiling"
  if (input.ratio >= input.threshold && input.wpBoundary) return "threshold-wp"
  return null
}

export type Transition =
  | { type: "start-monitoring" }
  | { type: "request-handoff"; reason: TriggerReason }
  | { type: "handoff-written" }
  | { type: "handoff-retry" }
  | { type: "handoff-give-up" }
  | { type: "cleared" }
  | { type: "continuation-injected" }
  | { type: "turn-completed" }

export function reduce(state: MachineState, event: Transition): MachineState {
  switch (event.type) {
    case "start-monitoring":
      return { ...state, phase: "monitoring" }
    case "request-handoff":
      return {
        ...state,
        phase: "handoff-requested",
        lastTrigger: event.reason,
        handoffAttempts: 1,
      }
    case "handoff-written":
      return { ...state, phase: "clearing", handoffAttempts: 0, lastHandoffNumber: state.lastHandoffNumber + 1 }
    case "handoff-retry":
      return { ...state, phase: "handoff-requested", handoffAttempts: state.handoffAttempts + 1 }
    case "handoff-give-up":
      return { ...state, phase: "monitoring", lastTrigger: null, handoffAttempts: 0 }
    case "cleared":
      return { ...state, phase: "cleared" }
    case "continuation-injected":
      return { ...state, phase: "monitoring", lastTrigger: null, turnsSinceHandoff: 0 }
    case "turn-completed":
      return { ...state, turnsSinceHandoff: state.turnsSinceHandoff + 1 }
  }
}
