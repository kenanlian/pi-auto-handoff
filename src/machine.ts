export type Phase = "monitoring" | "injecting" | "written"

export type MachineState = {
  phase: Phase
  handoffAttempts: number
  lastHandoffNumber: number
}

export type EvaluateInput = {
  enabled: boolean
  ratio: number
  threshold: number
  phase: Phase
}

export function initialState(): MachineState {
  return {
    phase: "monitoring",
    handoffAttempts: 0,
    lastHandoffNumber: 0,
  }
}

/** v2 single threshold: fire on the next context event while still monitoring. */
export function evaluateTrigger(input: EvaluateInput): boolean {
  if (!input.enabled) return false
  if (input.phase !== "monitoring") return false
  return input.ratio >= input.threshold
}

export type Transition =
  | { type: "start-monitoring" }
  | { type: "request-handoff" }
  | { type: "handoff-written" }
  | { type: "handoff-retry" }
  | { type: "handoff-give-up" }
  | { type: "cleared" }

export function reduce(state: MachineState, event: Transition): MachineState {
  switch (event.type) {
    case "start-monitoring":
      return { ...state, phase: "monitoring" }
    case "request-handoff":
      return {
        ...state,
        phase: "injecting",
        handoffAttempts: 1,
      }
    case "handoff-written":
      return {
        ...state,
        phase: "written",
        handoffAttempts: 0,
        lastHandoffNumber: state.lastHandoffNumber + 1,
      }
    case "handoff-retry":
      return { ...state, phase: "injecting", handoffAttempts: state.handoffAttempts + 1 }
    case "handoff-give-up":
      return { ...state, phase: "monitoring", handoffAttempts: 0 }
    case "cleared":
      return { ...state, phase: "monitoring" }
  }
}
