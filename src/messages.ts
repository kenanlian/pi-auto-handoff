export type AgentMessageLike = {
  role: string
  timestamp?: number
  content?: unknown
  toolCallId?: string
  toolName?: string
  model?: string
  responseId?: string
}

export type ClearResult = { kept: number; mode: "cursor" | "last-user" | "empty" | "since" }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join("\n")
}

export function messageKey(message: AgentMessageLike): string {
  if (message.role === "toolResult") {
    return `tr:${message.toolCallId ?? ""}:${message.timestamp ?? 0}`
  }
  if (message.role === "assistant") {
    return `a:${message.timestamp ?? 0}:${message.model ?? ""}:${message.responseId ?? ""}`
  }
  if (message.role === "user") {
    return `u:${message.timestamp ?? 0}:${textOf(message.content).slice(0, 120)}`
  }
  return `${message.role}:${message.timestamp ?? 0}`
}

/** Fixed stable key for the synthetic injected directive. Never Date.now(). */
export function injectKey(handoffNumber: number): string {
  return `handoff-inject:${handoffNumber}`
}

export function continuationUser(text: string, timestamp = 0): AgentMessageLike {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  }
}

/** Match `<!-- pi-auto-handoff-continuation n=... -->` inside a user message; returns n or null. */
export function continuationMarker(text: string): number | null {
  const match = /<!--\s*pi-auto-handoff-continuation\s+n=(\d+)\s*-->/.exec(text)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

export function idsOf(messages: AgentMessageLike[]): string[] {
  return messages.map(messageKey).filter((id) => id.length > 0)
}

export function applyClear(
  messages: AgentMessageLike[],
  input: { keepFromId?: string; replacementText?: string },
): ClearResult {
  if (input.keepFromId) {
    const idx = messages.findIndex((m) => messageKey(m) === input.keepFromId)
    if (idx >= 0) {
      messages.splice(0, idx)
      return { kept: messages.length, mode: "cursor" }
    }
  }

  if (input.replacementText !== undefined) {
    const clone = continuationUser(input.replacementText)
    messages.splice(0, messages.length, clone)
    return { kept: 1, mode: "last-user" }
  }

  messages.splice(0, messages.length)
  return { kept: 0, mode: "empty" }
}

/** Keep a continuation user clone plus messages created after the clear snapshot. */
export function applyFilterSince(
  messages: AgentMessageLike[],
  preClearIds: ReadonlySet<string>,
  continuationText: string,
): ClearResult {
  const newer = messages.filter((m) => !preClearIds.has(messageKey(m)))
  const clone = continuationUser(continuationText)
  messages.splice(0, messages.length, clone, ...newer)
  return { kept: messages.length, mode: "since" }
}

const REQUIRED_HEADINGS = [
  /##\s*task goal/i,
  /##\s*work packages/i,
  /##\s*pointers/i,
  /##\s*exact interrupt point/i,
  /##\s*next actions/i,
  /##\s*risks/i,
]

export function verifyHandoffBody(body: string): boolean {
  const text = body.trim()
  if (text.length < 40) return false
  return REQUIRED_HEADINGS.every((re) => re.test(text))
}
