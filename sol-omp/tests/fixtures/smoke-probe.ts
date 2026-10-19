/** Test-only OMP extension. This does not emulate an OMP host or model. */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ContextEvent, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ObservationPack, runtimeRoot } from "../../src/omp/observation-pack.ts";
import { createObservation } from "../../src/upstream/sol-pi/observation-pack/observation.ts";

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
      const searches = all.filter(tool => tool.name === "obs_search");
      assert.equal(searches.length, 1, "sol-omp must register exactly one obs_search");
      assert.equal(await realpath(searches[0]!.sourceInfo.path), await realpath(entry));
      for (const name of ["edit", "write"]) {
        const tool = all.find(candidate => candidate.name === name);
        if (tool) assert.notEqual(tool.sourceInfo.source, "extension", `${name} must not be overridden`);
      }
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionId = ctx.sessionManager.getSessionId();
      assert.ok(sessionDir && isAbsolute(sessionDir), "persistent session directory must be public");
      assert.match(sessionId, /^[a-z0-9][a-z0-9._-]*$/iu);
      // Exercise real session paths and archive helpers without requesting a
      // model or pretending this proves provider-side Context projection.
      const source = "prefix line\n".repeat(1500) + "SMOKE_MIDDLE_证据🙂\n" + "tail line\n".repeat(1000);
      const message = { role: "toolResult", toolCallId: "smoke-archive", toolName: "smoke-text",
        content: [{ type: "text", text: source }], isError: false, timestamp: 1 } as ContextEvent["messages"][number];
      const pack = new ObservationPack();
      const root = runtimeRoot(ctx);
      const projected = await pack.project([message], root);
      assert.notEqual(projected[0], message);
      const id = createObservation(message as Parameters<typeof createObservation>[0], root)!.id;
      const search = await pack.search(root, id, "SMOKE_MIDDLE_证据🙂");
      assert.equal(search.details.matches.length, 1);
      assert.equal(search.details.matches[0]!.offset, Buffer.byteLength("prefix line\n".repeat(1500)));
      let offset = 0;
      let recovered = "";
      for (;;) {
        const page = await pack.recall(root, id, offset);
        recovered += page.content[0]!.text.split("\n").slice(2).join("\n");
        if (page.details.eof) break;
        assert.ok(page.details.nextOffset > offset);
        offset = page.details.nextOffset;
      }
      assert.equal(recovered, source);
      console.error("SOL_OMP_SMOKE_PROBE=" + JSON.stringify({
        status: "PASS", agentDir: api.pi.getAgentDir(), sessionDir, sessionId,
        tool: recalls[0]!.name, searchTool: searches[0]!.name, source: recalls[0]!.sourceInfo, hostVersion: api.pi.VERSION,
        archiveSearch: "PASS", byteRecall: "PASS", sourceBytes: Buffer.byteLength(source),
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
