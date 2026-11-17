import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
const root = dirname(dirname(fileURLToPath(import.meta.url)))
test("failed smoke retains its real diagnostic report without recreating .dev", () => {
  assert.ok(process.env.TMPDIR, "TMPDIR is required for isolated tests")
  const fixture = mkdtempSync(join(process.env.TMPDIR, "handoff-report-"))
  try {
    mkdirSync(join(fixture, "scripts")); mkdirSync(join(fixture, "src"))
    writeFileSync(join(fixture, "package.json"), '{"type":"module"}')
    copyFileSync(join(root, "scripts/smoke.ts"), join(fixture, "scripts/smoke.ts"))
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/smoke.ts"], {
      cwd: fixture, encoding: "utf8", env: { ...process.env, OPENCODE_BIN: "/usr/bin/false", PI_BIN: "/usr/bin/false" },
    })
    assert.notEqual(result.status, 0, "a deliberately failing local CLI cannot pass the smoke")
    const reportPath = join(fixture, ".smoke-reports/smoke-report.json")
    assert.ok(existsSync(reportPath), "failed smoke must retain its report outside the retired directory")
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    assert.equal(report.status, 1); assert.ok(report.failures.length > 0)
    assert.equal(existsSync(join(fixture, ".dev")), false)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
