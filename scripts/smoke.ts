#!/usr/bin/env node
/**
 * v2 e2e smoke: pure threshold trigger (contextThreshold=0.0001 → first context
 * event injects mid-run). Chain: inject → model writes handoff → verify → clear →
 * same PID + same session-id continues → WP-2 done → exit 0. A mocked-only run
 * is not success.
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

- [ ] **WP-1** Fake package (context trips the threshold long before this matters)
- [ ] **WP-2** Create done-wp2.txt containing exactly ok
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
2. Start WP-1: read the plan file once. That is all WP-1 requires.
3. At some point you will receive a [pi-auto-handoff] CONTEXT CRITICAL instruction appended as a user message. When you see it: STOP the original task immediately. Write the handoff markdown to the exact path it specifies (under ${handoffDir}) with all six required ## sections, then reply with the single line HANDOFF WRITTEN and nothing else. Do not continue working after that.
4. Later you will receive a [pi-auto-handoff continuation] user message with the handoff document inlined. Resume from it: using bash write a single line to ${identAfter} containing: $PPID, a space, then $PI_SESSION_ID.
5. Then do WP-2: write ${doneFile} containing exactly the two letters ok and nothing else. Do not mark WP-2 done in the plan.
6. Reply SMOKE_DONE.

Do not edit README, src/, or package.json. Do not wait for a human. Do not keep re-reading files in a loop.`

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
const requested = countLog(eventsLog, "handoff-requested")
const injectedEvents = countLog(eventsLog, "handoff-injected")
const written = countLog(eventsLog, "handoff-written")
const cleared = countLog(eventsLog, "messages-cleared")
const clearedEvent = parseJsonl(eventsLog).find((e) => {
	return Boolean(e && typeof e === "object" && (e as { message?: string }).message === "messages-cleared")
}) as { extra?: { before?: number; after?: number } } | undefined
const contextBefore = clearedEvent?.extra?.before
const contextAfter = clearedEvent?.extra?.after
const events = parseJsonl(stdout)
const sessionHeader = events.find((e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "session") as
	| { id?: string; type?: string }
	| undefined
const sessionFiles = existsSync(sessionDir)
	? readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
	: []
const sessionPath = sessionFiles.length > 0 ? join(sessionDir, String(sessionFiles[0])) : null
const sessionRaw = sessionPath && existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : ""
const durableEntries = sessionRaw.split("\n").filter((l) => l.trim()).length
const durableBefore = durableEntries

const failures: string[] = []
if (result.error) failures.push(`process error: ${String(result.error)}`)
if (result.status !== 0) failures.push(`exit status ${result.status} (want 0)`)
if (handoffs.length < 1) failures.push("no handoff-*.md written")
if (doneBody?.trim() !== "ok") failures.push(`WP-2 file missing or not exactly ok (got ${JSON.stringify(doneBody)})`)
if (requested < 1) failures.push(`handoff-requested count ${requested} (want >= 1)`)
if (injectedEvents < 1) failures.push(`handoff-injected count ${injectedEvents} (want >= 1; mid-run injection missing)`)
if (written !== requested) failures.push(`handoff-written count ${written} !== handoff-requested ${requested}`)
if (cleared !== written) failures.push(`messages-cleared count ${cleared} !== plugin handoff-written ${written}`)
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
	counts: {
		requested,
		injected: injectedEvents,
		written,
		cleared,
		durableEntries,
		durableBefore,
		contextBefore,
		contextAfter,
	},
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
	counts: report.counts,
})
process.exit(0)
