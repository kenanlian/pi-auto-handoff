#!/usr/bin/env node
/**
 * e2e smoke: threshold + WP-1 flip must produce a real continuation that
 * finishes WP-2 and exits 0. A mocked-only run is not success.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pi = process.env.PI_BIN ?? "pi"
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const smokeDir = join(root, ".smoke", stamp)
const planFile = join(smokeDir, "plan.md")
const handoffDir = join(smokeDir, "handoff")
const doneFile = join(smokeDir, "done-wp2.txt")
const identBefore = join(smokeDir, "ident-before.txt")
const identAfter = join(smokeDir, "ident-after.txt")
const sessionDir = join(smokeDir, "sessions")
const eventsFile = join(handoffDir, ".auto-handoff-events.jsonl")
const extension = join(root, "src/index.ts")

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function countLog(text: string, name: string): number {
  const patterns = [
    new RegExp(`"message":"${name}"`, "g"),
    new RegExp(`"message": "${name}"`, "g"),
  ]
  let n = 0
  for (const re of patterns) {
    n = Math.max(n, (text.match(re) ?? []).length)
  }
  return n
}

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // ignore non-JSON
    }
  }
  return out
}

mkdirSync(handoffDir, { recursive: true })
mkdirSync(sessionDir, { recursive: true })
write(
  planFile,
  `# Smoke plan

- [ ] **WP-1** Fake package to complete during this run
- [ ] **WP-2** Create done-wp2.txt containing exactly ok

<!-- handoffs -->
`,
)

const prompt = `Working directory is ${root}. Only edit these smoke files:

Plan file (absolute): ${planFile}
Handoff directory (absolute): ${handoffDir}
WP-2 output file (absolute): ${doneFile}
Identity-before file (absolute): ${identBefore}
Identity-after file (absolute): ${identAfter}

Steps:
1. Using bash, write a single line to ${identBefore} containing: the parent process id ($PPID), a space, then $PI_SESSION_ID. Do not write anything else to that file.
2. Edit the plan file so WP-1 is marked done: \`- [x] **WP-1** Fake package to complete during this run\`
3. After that edit, if you receive handoff instructions, write the handoff markdown to the exact path they specify (it will be under ${handoffDir}) with every required section, then stop and wait for the continuation user message.
4. After continuation, using bash write a single line to ${identAfter} containing: $PPID, a space, then $PI_SESSION_ID.
5. Then do WP-2: write ${doneFile} containing exactly the two letters ok and nothing else. Do not mark WP-2 done in the plan.
6. Reply SMOKE_DONE.

Do not edit README, src/, or package.json. Do not wait for a human. Do not keep re-reading the handoff file in a loop.`

const result = spawnSync(
  pi,
  [
    "--no-extensions",
    "-e",
    extension,
    "--mode",
    "json",
    "--approve",
    "--thinking",
    "off",
    "--session-dir",
    sessionDir,
    "--name",
    "handoff-smoke",
    "--provider",
    process.env.PI_SMOKE_PROVIDER ?? "opencode-go",
    "--model",
    process.env.PI_SMOKE_MODEL ?? "mimo-v2.5",
    "--",
    prompt,
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      PI_AUTO_HANDOFF_ENABLED: "true",
      PI_AUTO_HANDOFF_CONTEXT_THRESHOLD: "0.0001",
      PI_AUTO_HANDOFF_HARD_CEILING: "0.99",
      PI_AUTO_HANDOFF_MIN_TURNS: "0",
      PI_AUTO_HANDOFF_HANDOFF_DIR: handoffDir,
      PI_AUTO_HANDOFF_PLAN_FILE: planFile,
      PI_AUTO_HANDOFF_LOGGING: "true",
      PI_AUTO_HANDOFF_TIMEOUT_MS: "90000",
    },
  },
)

const stderr = result.stderr ?? ""
const stdout = result.stdout ?? ""
const eventsLog = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : ""
const files = existsSync(handoffDir) ? readdirSync(handoffDir) : []
const handoffs = files.filter((f) => f.startsWith("handoff-") && f.endsWith(".md"))
const doneBody = existsSync(doneFile) ? readFileSync(doneFile, "utf8") : null
const beforeBody = existsSync(identBefore) ? readFileSync(identBefore, "utf8").trim() : ""
const afterBody = existsSync(identAfter) ? readFileSync(identAfter, "utf8").trim() : ""
const [beforePid, beforeSession] = beforeBody.split(/\s+/)
const [afterPid, afterSession] = afterBody.split(/\s+/)
const cleared = countLog(eventsLog, "messages-cleared")
const injected = countLog(eventsLog, "continuation-injected")
const projected = countLog(eventsLog, "continuation-projected")
const requested = countLog(eventsLog, "handoff-requested")
const written = countLog(eventsLog, "handoff-written")
const continuations = injected + projected
const clearedEvent = parseJsonl(eventsLog).find((e) => {
  return Boolean(e && typeof e === "object" && (e as { message?: string }).message === "messages-cleared")
}) as { extra?: { before?: number; after?: number } } | undefined
const contextBefore = clearedEvent?.extra?.before
const contextAfter = clearedEvent?.extra?.after
const events = parseJsonl(stdout)
const sessionHeader = events.find((e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "session") as
  | { id?: string; type?: string }
  | undefined
const userMessages = events.filter((e) => {
  if (!e || typeof e !== "object") return false
  const rec = e as { type?: string; message?: { role?: string } }
  return rec.type === "message_end" && rec.message?.role === "user"
})
const sessionFiles = existsSync(sessionDir)
  ? readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
  : []
const sessionPath = sessionFiles.length > 0 ? join(sessionDir, String(sessionFiles[0])) : null
const sessionRaw = sessionPath && existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : ""
const durableEntries = sessionRaw.split("\n").filter((l) => l.trim()).length

const failures: string[] = []
if (result.error) failures.push(`process error: ${String(result.error)}`)
if (result.status !== 0) failures.push(`exit status ${result.status} (want 0)`)
if (handoffs.length < 1) failures.push("no handoff-*.md written")
if (doneBody?.trim() !== "ok") failures.push(`WP-2 file missing or not exactly ok (got ${JSON.stringify(doneBody)})`)
if (continuations < 1) failures.push("no continuation (neither continuation-injected nor continuation-projected)")
if (injected > 1 || projected > 1) failures.push(`duplicate continuation logs injected=${injected} projected=${projected}`)
if (requested < 1) failures.push(`handoff-requested count ${requested} (want >= 1)`)
if (written !== requested) failures.push(`handoff-written count ${written} !== handoff-requested ${requested}`)
if (cleared !== written) {
  failures.push(`messages-cleared count ${cleared} !== plugin handoff-written ${written}`)
}
if (cleared > 8) failures.push(`messages-cleared count ${cleared} looks like the per-call loop`)
if (typeof contextBefore === "number" && typeof contextAfter === "number" && !(contextAfter < contextBefore)) {
  failures.push(`context was not reduced (before=${contextBefore} after=${contextAfter})`)
}
if (!beforePid || !afterPid) failures.push(`identity files missing (before=${JSON.stringify(beforeBody)} after=${JSON.stringify(afterBody)})`)
if (beforePid && afterPid && beforePid !== afterPid) {
  failures.push(`PID changed: before=${beforePid} after=${afterPid} spawn=${result.pid}`)
}
if (result.pid && beforePid && String(result.pid) !== beforePid) {
  failures.push(`spawn pid ${result.pid} !== bash PPID ${beforePid}`)
}
if (beforeSession && afterSession && beforeSession !== afterSession) {
  failures.push(`session id changed: before=${beforeSession} after=${afterSession}`)
}
if (sessionHeader?.id && beforeSession && sessionHeader.id !== beforeSession) {
  failures.push(`json session header ${sessionHeader.id} !== PI_SESSION_ID ${beforeSession}`)
}
if (durableEntries < 4) {
  failures.push(`durable session too small (${durableEntries} jsonl lines); history may have been deleted`)
}
if (userMessages.length < 1) {
  failures.push(`expected the original user message in the json stream, got ${userMessages.length}`)
}

const report = {
  status: result.status,
  error: result.error ? String(result.error) : null,
  spawnPid: result.pid ?? null,
  stdoutTail: stdout.slice(-3000),
  stderrTail: stderr.slice(-4000),
  smokeDir,
  files,
  handoffs,
  doneBody,
  identity: { beforeBody, afterBody, beforePid, afterPid, beforeSession, afterSession },
  sessionHeader: sessionHeader ?? null,
  counts: { requested, written, cleared, injected, projected, continuations, userMessages: userMessages.length, durableEntries, contextBefore, contextAfter },
  sessionFiles,
  failures,
  plan: existsSync(planFile) ? readFileSync(planFile, "utf8") : null,
}

mkdirSync(join(root, ".dev/spike-evidence"), { recursive: true })
write(join(root, ".dev/spike-evidence/smoke-report.json"), JSON.stringify(report, null, 2))

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
}

if (process.env.SMOKE_KEEP !== "1") {
  rmSync(join(root, ".smoke"), { recursive: true, force: true })
}

console.log("smoke ok", {
  handoffs: handoffs.join(", "),
  pid: beforePid,
  session: beforeSession,
  counts: { requested, written, cleared, injected, projected, continuations, durableEntries, contextBefore, contextAfter },
})
process.exit(0)
