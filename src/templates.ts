import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const bundledDir = join(here, "..", "templates")

export function loadText(path: string | undefined, bundledName: string): string {
  if (path && path.trim()) {
    return readFileSync(path, "utf8")
  }
  return readFileSync(join(bundledDir, bundledName), "utf8")
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? "") : ""
  })
}

export function bundledHandoffPrompt(): string {
  return loadText(undefined, "handoff-prompt.md")
}

export function bundledContinuationPrompt(): string {
  return loadText(undefined, "continuation-prompt.md")
}
