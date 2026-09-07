export type WpStatus = "todo" | "in-progress" | "blocked" | "done"

export type WorkPackage = {
  id: string
  status: WpStatus
  title: string
  detail: string
}

export type PlanSnapshot = {
  packages: WorkPackage[]
  handoffCount: number
}

const DONE = new Set(["done", "verified", "complete", "x", "finished"])
const IN_PROGRESS = new Set(["in-progress", "doing", "wip", "active", "~"])
const BLOCKED = new Set(["blocked", "blocked!", "!", "waiting"])

export function normalizeStatus(raw: string): WpStatus {
  const key = raw.trim().toLowerCase()
  if (DONE.has(key)) return "done"
  if (IN_PROGRESS.has(key)) return "in-progress"
  if (BLOCKED.has(key)) return "blocked"
  return "todo"
}

function parseCheckbox(mark: string): WpStatus {
  const inner = mark.trim()
  if (inner === "x" || inner === "X") return "done"
  if (inner === "~" || inner === "-") return "in-progress"
  if (inner === "!" || inner === "b") return "blocked"
  return "todo"
}

export function parsePlan(markdown: string): PlanSnapshot {
  const packages: WorkPackage[] = []
  const seen = new Set<string>()

  const tableRe = /^\|\s*(WP-?\d+|[A-Z]*WP-?\d+)\s*\|\s*([^|]+)\|/gim
  for (const match of markdown.matchAll(tableRe)) {
    const id = (match[1] ?? "").toUpperCase().replace(/^(WP)(\d)/, "WP-$2")
    const status = normalizeStatus(match[2] ?? "todo")
    if (!id.startsWith("WP") || seen.has(id)) continue
    seen.add(id)
    packages.push({ id, status, title: id, detail: (match[2] ?? "").trim() })
  }

  const listRe = /^[-*]\s+\[([xX ~!b-])\]\s+\*?\*?(WP-?\d+)\*?\*?[ —:-]*([^\n]*)/gim
  for (const match of markdown.matchAll(listRe)) {
    const id = (match[2] ?? "").toUpperCase().replace(/^(WP)(\d)/, "WP-$2")
    if (seen.has(id)) continue
    seen.add(id)
    packages.push({
      id,
      status: parseCheckbox(match[1] ?? " "),
      title: (match[3] ?? "").trim() || id,
      detail: (match[3] ?? "").trim(),
    })
  }

  let handoffCount = 0
  for (const match of markdown.matchAll(/<!--\s*handoff\s+n=(\d+)/gi)) {
    const n = Number(match[1])
    if (Number.isFinite(n)) handoffCount = Math.max(handoffCount, n)
  }
  const heading = markdown.match(/##\s*Handoffs[\s\S]*$/i)
  if (heading) {
    const rows = [...heading[0].matchAll(/^\|\s*(\d+)\s*\|/gm)]
    for (const row of rows) {
      const n = Number(row[1])
      if (Number.isFinite(n)) handoffCount = Math.max(handoffCount, n)
    }
  }

  return { packages, handoffCount }
}

export function newlyCompleted(prev: PlanSnapshot | null, next: PlanSnapshot): string[] {
  const prevMap = new Map((prev?.packages ?? []).map((wp) => [wp.id, wp.status]))
  return next.packages
    .filter((wp) => wp.status === "done" && prevMap.get(wp.id) !== "done")
    .map((wp) => wp.id)
}

export function nextIncomplete(snapshot: PlanSnapshot): WorkPackage | undefined {
  return snapshot.packages.find((wp) => wp.status !== "done")
}

export function appendHandoffMarker(markdown: string, input: { n: number; file: string; ts: string }): string {
  const marker = `<!-- handoff n=${input.n} file=${input.file} ts=${input.ts} -->`
  if (markdown.includes(`<!-- handoff n=${input.n} `)) return markdown
  if (/<!--\s*handoffs\s*-->/i.test(markdown)) {
    return markdown.replace(/<!--\s*handoffs\s*-->/i, `<!-- handoffs -->\n${marker}`)
  }
  if (/##\s*Handoffs/i.test(markdown)) {
    return `${markdown.trimEnd()}\n\n${marker}\n`
  }
  return `${markdown.trimEnd()}\n\n## Handoffs\n\n${marker}\n`
}
