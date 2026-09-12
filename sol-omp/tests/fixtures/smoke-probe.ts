/** Test-only OMP extension. This does not emulate an OMP host or model. */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function smokeProbe(api: ExtensionAPI): void {
  api.on("session_start", async (_event, ctx) => {
    try {
      const entry = process.env.SOL_OMP_SMOKE_ENTRY;
      const expectedAgent = process.env.PI_CODING_AGENT_DIR;
      assert.ok(entry && expectedAgent, "run this fixture through scripts/smoke.ts");
      assert.equal(await realpath(api.pi.getAgentDir()), await realpath(expectedAgent));
      const all = api.getAllTools();
      const recalls = all.filter(tool => tool.name === "obs_recall");
      assert.equal(recalls.length, 1, "sol-omp must register exactly one obs_recall");
      assert.equal(await realpath(recalls[0]!.sourceInfo.path), await realpath(entry));
      for (const name of ["edit", "write"]) {
        const tool = all.find(candidate => candidate.name === name);
        if (tool) assert.notEqual(tool.sourceInfo.source, "extension", `${name} must not be overridden`);
      }
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionId = ctx.sessionManager.getSessionId();
      assert.ok(sessionDir && isAbsolute(sessionDir), "persistent session directory must be public");
      assert.match(sessionId, /^[a-z0-9][a-z0-9._-]*$/iu);
      console.error("SOL_OMP_SMOKE_PROBE=" + JSON.stringify({
        status: "PASS", agentDir: api.pi.getAgentDir(), sessionDir, sessionId,
        tool: recalls[0]!.name, source: recalls[0]!.sourceInfo, hostVersion: api.pi.VERSION,
      }));
    } catch (error) {
      console.error("SOL_OMP_SMOKE_PROBE=" + JSON.stringify({
        status: "FAIL", error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    } finally {
      ctx.shutdown();
    }
  });
}
