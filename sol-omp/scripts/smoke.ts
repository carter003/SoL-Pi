/** Launch the pinned installed OMP CLI, with no inherited user config or credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_OMP = "18.1.18";
const EXPECTED_BUN = "1.3.14";
class Blocked extends Error {}

async function runCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let timedOut = false; let outputLimit = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    function terminate() {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      force = setTimeout(() => {
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }, 1000);
    }
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 30_000);
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      if (!outputLimit && Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) {
        outputLimit = true; terminate();
      }
    };
    child.stdout.on("data", (data: Buffer) => capture("stdout", data));
    child.stderr.on("data", (data: Buffer) => capture("stderr", data));
    child.on("error", error => { clearTimeout(timer); if (force) clearTimeout(force); reject(error); });
    child.on("close", code => {
      clearTimeout(timer); if (force) clearTimeout(force);
      if (timedOut || outputLimit) reject(new Error(`OMP smoke ${timedOut ? "timed out" : "exceeded output limit"}\n${stderr.slice(-6000)}`));
      else resolveResult({ code, stdout, stderr });
    });
    // Keep RPC stdin open. The test-only session_start probe requests graceful shutdown.
  });
}

async function main(): Promise<void> {
  if (process.versions.bun !== EXPECTED_BUN) {
    throw new Blocked(`Requires Bun ${EXPECTED_BUN}; actual Bun=${process.versions.bun ?? "not running under Bun"}`);
  }
  if (process.platform !== "linux") throw new Blocked("This first smoke target is Linux only");
  const hostRoot = join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
  let host: { name: string; version: string; bin: { omp: string } };
  try { host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8")); }
  catch { throw new Blocked("Pinned local OMP package is missing or unreadable; run bun install first"); }
  assert.equal(host.name, "@oh-my-pi/pi-coding-agent");
  assert.equal(host.version, EXPECTED_OMP, "Do not accidentally test a different OMP version");
  assert.equal(typeof host.bin.omp, "string");
  const cli = resolve(hostRoot, host.bin.omp);
  const relativeCli = relative(hostRoot, cli);
  assert.ok(!relativeCli.startsWith("..") && !isAbsolute(relativeCli), "OMP CLI must belong to its local package");
  const testRoot = await mkdtemp(join(tmpdir(), "sol-omp-real-host-"));
  try {
    for (const enabled of [false, true]) {
      const scope = join(testRoot, enabled ? "enabled" : "disabled");
      const agent = join(scope, "agent"); const project = join(scope, "project");
      const home = join(scope, "home"); const sessions = join(scope, "sessions");
      for (const directory of [agent, project, home, sessions]) await mkdir(directory, { recursive: true });
      await writeFile(join(agent, "sol-omp.json"), JSON.stringify({ version: 1, observationPack: enabled, actionFusion: false }));
      const entry = join(root, "src", "index.ts");
      // A whitelist, NOT {...process.env}: never inherit model keys or real OMP settings.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: scope, LANG: "C.UTF-8", TERM: "dumb",
        PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions,
        OMP_PROFILE: "", PI_PROFILE: "", XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
        SOL_OMP_SMOKE_ENTRY: entry,
      };
      const version = await runCli(cli, ["--version"], project, env);
      assert.equal(version.code, 0, version.stderr);
      assert.match(version.stdout + version.stderr, /\b18\.1\.18\b/);
      // Explicit catalog selection avoids the credential-filtered automatic default.
      // No prompt is sent, no credentials are injected, and this does not test model inference.
      const args = ["--model", "openai/gpt-5", "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty",
        "--session-dir", sessions, "--extension", enabled ? entry : root,
        "--extension", join(root, "tests", "fixtures", "smoke-probe.ts")];
      const result = await runCli(cli, args, project, env);
      assert.equal(result.code, 0, result.stderr);
      const evidence = result.stderr.split(/\r?\n/).find(line => line.startsWith("SOL_OMP_SMOKE_PROBE="));
      assert.ok(evidence, `Missing real host probe result\n${result.stderr}`);
      const probe = JSON.parse(evidence.slice("SOL_OMP_SMOKE_PROBE=".length));
      assert.equal(probe.status, "PASS", JSON.stringify(probe));
      assert.ok(result.stderr.includes(`[sol-omp] loaded observationPack=${enabled} actionFusion=false`));
      console.log(JSON.stringify({ status: "PASS", check: "OMP_LOAD", observationPack: enabled,
        bun: process.versions.bun, omp: host.version, probe }));
    }
    console.log("SMOKE=PASS (real OMP loading/shutdown only; not MODEL_E2E)");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`SMOKE=${error instanceof Blocked ? "BLOCKED" : "FAIL"}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
