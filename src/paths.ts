import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

export function abs(directory: string, p: string): string {
  return resolve(directory, p)
}

export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-")
}

export function nextHandoffPath(handoffDir: string, directory: string, n: number, now = new Date()): string {
  const dir = abs(directory, handoffDir)
  mkdirSync(dir, { recursive: true })
  return join(dir, `handoff-${String(n).padStart(3, "0")}-${stamp(now)}.md`)
}

export function eventsLogPath(handoffDir: string, directory: string): string {
  const dir = abs(directory, handoffDir)
  mkdirSync(dir, { recursive: true })
  return join(dir, ".auto-handoff-events.jsonl")
}
