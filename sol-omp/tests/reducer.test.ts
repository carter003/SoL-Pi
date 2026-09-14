import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { EvidencePreservingReducer, registerEvidencePreservingReducer, resultFailed } from "../src/omp/evidence-preserving-reducer.ts";
import { ObservationPack, runtimeRoot } from "../src/omp/observation-pack.ts";
import type { callReducer } from "../src/omp/reducer-provider.ts";
import { archiveBody } from "../src/upstream/sol-pi/evidence-preserving-reducer/archive.ts";
import { loadReducerConfig, REDUCER_RECEIPT_SCHEMA } from "../src/upstream/sol-pi/evidence-preserving-reducer/config.ts";
import { fakeApi, sessionContext, temporary, toolMessage, toolText } from "./helpers.ts";

const config = { ...DEFAULT_CONFIG, evidencePreservingReducer: true,
  evidencePreservingReducerProvider: "opencode-go", evidencePreservingReducerModel: "glm-5.3-flash" };
const body = "PASS synthetic check\n".repeat(900) + "WARNING integration checks NOT RUN\n";
const signal = () => new AbortController().signal;
const quiet = () => {};

test("structured OMP result state outranks status-like text", () => {
  const content = [{ type: "text" as const, text: "Command exited with code 7\nprocess.exitCode = 1" }];
  assert.equal(resultFailed({ isError: false, details: { exitCode: 0 }, content }), false);
  assert.equal(resultFailed({ isError: false, details: { exitCode: 7 }, content }), true);
  assert.equal(resultFailed({ isError: false, details: {}, content }), true);
  assert.equal(resultFailed({ isError: false, details: { exitCode: 0, timedOut: true }, content }), true);
});
function event(text = body, id = "call-a", details: unknown = {}, command = "npm test"): ToolResultEvent {
  return { type: "tool_result", toolName: "bash", toolCallId: id, input: { command },
    content: [{ type: "text", text }], details, isError: false } as ToolResultEvent;
}
const valid: typeof callReducer = async (_config, _command, failed, archive, source) => ({
  provider: "opencode-go", model: "glm-5.3-flash", errorMessage: undefined, ok: true, stopReason: "stop", durationMs: 1, attempts: 1, usageComplete: true,
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
  cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
  outputText: JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: failed ? "failure" : "success",
    uncertain: true, evidence: [{ kind: failed ? "failure" : "warning", quote: source.split("\n").find(line => (failed ? /ERROR/ : /WARNING/).test(line)) }] }),
});

test("reducer rejects compound inspections and accepts adapter diagnostic commands", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  let calls = 0;
  const reducer = new EvidencePreservingReducer(config, async (...args) => { calls++; return valid(...args); }, quiet);
  const denseMessage = toolMessage(body, { toolName: "bash", toolCallId: "call-dense" });
  reducer.observe(event(body, "call-dense", {}, "cat src/index.ts && npm test"), root);
  await reducer.settle([denseMessage], ctx, signal());
  assert.equal(calls, 0);
  assert.equal((await reducer.project([denseMessage], root)).messages[0], denseMessage);

  const bunMessage = toolMessage(body, { toolName: "bash", toolCallId: "call-bun" });
  reducer.observe(event(body, "call-bun", {}, "bun test"), root);
  await reducer.settle([bunMessage], ctx, signal());
  assert.equal(calls, 1);
  assert.match(toolText((await reducer.project([bunMessage], root)).messages[0]!), /sol_pi_evidence_receipt_v1/);
});

 test("receipt projection retains history, error status, and exact archive; repeated settle spends once", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  let requests = 0;
  const reducer = new EvidencePreservingReducer(config, async (...args) => { requests++; return valid(...args); }, quiet);
  const failedBody = body + "ERROR synthetic target failed\n";
  const source = event(failedBody, "call-a", { exitCode: 7 });
  const message = toolMessage(failedBody, { toolName: "bash", toolCallId: "call-a", isError: true });
  reducer.observe(source, root); reducer.observe(source, root);
  const before = await reducer.project([message], root); assert.equal(before.messages[0], message);
  await Promise.all([reducer.settle([message], ctx, signal()), reducer.settle([message], ctx, signal())]);
  for (let i = 0; i < 4; i++) {
    await reducer.settle([message], ctx, signal());
    const projected = await reducer.project([message], root);
    assert.match(toolText(projected.messages[0]!), /status=failure/);
    const projectedMessage = projected.messages[0];
    assert.ok(projectedMessage?.role === "toolResult");
    assert.equal(projectedMessage.isError, true);
    const packed = await new ObservationPack().project(projected.messages, root, quiet, projected.retained);
    assert.equal(packed[0], projected.messages[0]);
  }
  assert.equal(requests, 1); assert.equal(toolText(message), failedBody); assert.equal(source.isError, false);
  const archive = await archiveBody(loadReducerConfig(root).storeRoot, failedBody);
  await writeFile(archive.path, "tampered");
  assert.equal((await reducer.project([message], root)).messages[0], message);
});

 test("provider rejection, invalid quote and status mismatch fall back to Observation Pack", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  const providers: Array<typeof callReducer> = [async () => { throw new Error("provider failure"); },
    async (...args) => ({ ...await valid(...args), outputText: "not JSON" }),
    async (...args) => { const result = await valid(...args); const receipt = JSON.parse(result.outputText); receipt.evidence[0].quote = "invented evidence"; return { ...result, outputText: JSON.stringify(receipt) }; },
    async (...args) => { const result = await valid(...args); const receipt = JSON.parse(result.outputText); receipt.status = "failure"; return { ...result, outputText: JSON.stringify(receipt) }; }];
  for (const provider of providers) {
    let calls = 0; const reducer = new EvidencePreservingReducer(config, async (...args) => { calls++; return provider(...args); }, quiet);
    const message = toolMessage(body, { toolName: "bash", toolCallId: "call-a" });
    reducer.observe(event(), root);
    await reducer.settle([message], ctx, signal());
    for (let i = 0; i < 4; i++) {
      await reducer.settle([message], ctx, signal()); const projected = await reducer.project([message], root);
      assert.match(toolText((await new ObservationPack().project(projected.messages, root, quiet, projected.retained))[0]!), /large tool result replaced/);
    }
    assert.equal(calls, 1);
  }
});

 test("session cancellation discards late valid receipt and never retries", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx); const controller = new AbortController();
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const reducer = new EvidencePreservingReducer(config, async (...args) => {
    calls++; started(); await new Promise<void>(resolve => args[6].addEventListener("abort", () => resolve(), { once: true }));
    return valid(...args);
  }, quiet);
  const message = toolMessage(body, { toolName: "bash", toolCallId: "call-a" });
  reducer.observe(event(), root); const pending = reducer.settle([message], ctx, controller.signal);
  await entered; controller.abort(); await pending;
  await reducer.settle([message], ctx, signal());
  assert.equal((await reducer.project([message], root)).messages[0], message); assert.equal(calls, 1);
});

 test("sensitive, timed-out, asynchronous and ambiguous-success logs bypass reducer but are locally packed", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  const cases = [event(body + "api_key=synthetic-not-a-real-key"), event(body, "call-a", { timedOut: true }),
    event(body, "call-a", { async: { state: "running" } }), event(body + "ERROR contradictory result\n")];
  for (const source of cases) {
    let calls = 0; const reducer = new EvidencePreservingReducer(config, async (...args) => { calls++; return valid(...args); }, quiet);
    const message = toolMessage(source.content[0]!.type === "text" ? source.content[0]!.text : "", { toolName: "bash", toolCallId: "call-a" });
    reducer.observe(source, root); await reducer.settle([message], ctx, signal());
    const projected = await reducer.project([message], root);
    assert.match(toolText((await new ObservationPack().project(projected.messages, root, quiet, projected.retained))[0]!), /large tool result replaced/);
    assert.equal(calls, 0);
  }
});

 test("eval only replaces a unique associated exact log, preserving the envelope", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  const reducer = new EvidencePreservingReducer(config, valid, quiet);
  reducer.begin("eval", "outer", root); reducer.observe(event(), root);
  const envelope = JSON.stringify({ text: body, hasError: false, unrelated: "keep this" });
  reducer.observe({ ...event(envelope, "outer"), toolName: "eval" } as ToolResultEvent, root);
  const message = toolMessage(envelope, { toolName: "eval", toolCallId: "outer" });
  await reducer.settle([message], ctx, signal()); const projected = await reducer.project([message], root);
  const parsed = JSON.parse(toolText(projected.messages[0]!));
  assert.match(parsed.text, /sol_pi_evidence_receipt_v1/); assert.equal(parsed.hasError, false); assert.equal(parsed.unrelated, "keep this");
  assert.equal(toolText(message), envelope);
  const truncated = { ...message, content: [{ type: "text" as const, text: envelope.slice(0, 6000) }] };
  assert.equal((await reducer.project([truncated], root)).messages[0], truncated);
});

 test("same IDs in other sessions and restarted sessions do not inherit receipts", async t => {
  const directory = await temporary(t); const ctx = sessionContext(directory, "a"); const root = runtimeRoot(ctx);
  const reducer = new EvidencePreservingReducer(config, valid, quiet);
  const message = toolMessage(body, { toolName: "bash", toolCallId: "call-a" });
  reducer.observe(event(), root); await reducer.settle([message], ctx, signal());
  for (const [instance, sessionRoot] of [[reducer, runtimeRoot(sessionContext(directory, "b"))],
    [new EvidencePreservingReducer(config, valid, quiet), root]] as const) {
    const projected = await instance.project([message], sessionRoot);
    assert.match(toolText((await new ObservationPack().project(projected.messages, sessionRoot, quiet, projected.retained))[0]!), /large tool result replaced/);
  }
});

 test("enabled reducer requires explicit route and bounded timeout", () => {
  for (const patch of [{ evidencePreservingReducerProvider: "" }, { evidencePreservingReducerModel: null },
    { evidencePreservingReducerTimeoutMs: null }, { evidencePreservingReducerTimeoutMs: false },
    { evidencePreservingReducerTimeoutMs: 0 }, { evidencePreservingReducerTimeoutMs: 90001 }]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...config, ...patch })));
  }
  assert.equal(parseConfig(JSON.stringify(config)).evidencePreservingReducer, true);
});

test("settle shares its deadline across candidates, drains abort, and never retries leftovers", async t => {
  const ctx = sessionContext(await temporary(t)); const root = runtimeRoot(ctx);
  let calls = 0; let active = 0; let aborted = false;
  const reducer = new EvidencePreservingReducer({ ...config, evidencePreservingReducerTimeoutMs: 500 }, async (...args) => {
    calls++; active++;
    if (calls === 1) await new Promise(resolve => setTimeout(resolve, 150));
    else await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); args[6].removeEventListener("abort", cancel); resolve(); };
      const timer = setTimeout(finish, 900);
      const cancel = () => { aborted = true; clearTimeout(timer); setTimeout(finish, 20); };
      if (args[6].aborted) cancel(); else args[6].addEventListener("abort", cancel, { once: true });
    });
    active--; return valid(...args);
  }, quiet);
  const messages = ["a", "b", "c"].map(id => {
    reducer.observe(event(body, id), root);
    return toolMessage(body, { toolName: "bash", toolCallId: id });
  });
  await reducer.settle(messages, ctx, signal());
  assert.equal(active, 0); assert.equal(aborted, true); assert.equal(calls, 2);
  const projected = await reducer.project(messages, root);
  assert.match(toolText(projected.messages[0]!), /sol_pi_evidence_receipt_v1/);
  assert.equal(projected.messages[1], messages[1]); assert.equal(projected.messages[2], messages[2]);
  await reducer.settle(messages, ctx, signal()); assert.equal(calls, 2);
});

test("registered tool_result defers artifact I/O to cancellable settle", async t => {
  const { api, handlers, root } = await fakeApi(t);
  let lookups = 0;
  const ctx = sessionContext(root, "deferred", { getArtifactPath: async () => { lookups++; return null; } });
  const reducer = registerEvidencePreservingReducer(api, config)!;
  const preview = "PASS head\n[…82ln elided…]\n[raw output: artifact://2]";
  const message = toolMessage(preview, { toolName: "bash", toolCallId: "call-a" });
  await handlers.get("tool_result")!(event(preview), ctx);
  assert.equal(lookups, 0, "signal-less tool_result must not start recovery");
  assert.equal((await reducer.project([message], runtimeRoot(ctx))).messages[0], message);
  const controller = new AbortController(); controller.abort();
  await handlers.get("session_stop")!({ messages: [message], signal: controller.signal }, ctx);
  assert.equal(lookups, 0, "cancelled settle must not start recovery either");
});

test("already cancelled settle retains truncated candidates without recovery or retries", async t => {
  let lookups = 0; let calls = 0;
  const ctx = sessionContext(await temporary(t), "cancelled-recovery", {
    getArtifactPath: async () => { lookups++; return null; },
  });
  const root = runtimeRoot(ctx);
  const reducer = new EvidencePreservingReducer(config, async (...args) => { calls++; return valid(...args); }, quiet);
  const preview = "PASS head\n[…82ln elided…]\n[raw output: artifact://2]";
  const messages = ["a", "b"].map(id => {
    reducer.observe(event(preview, id), root);
    return toolMessage(preview, { toolName: "bash", toolCallId: id });
  });
  const controller = new AbortController(); controller.abort();
  await reducer.settle(messages, ctx, controller.signal);
  await reducer.settle(messages, ctx, signal());
  assert.equal(lookups, 0); assert.equal(calls, 0);
  const projected = await reducer.project(messages, root);
  assert.deepEqual(projected.messages, messages);
  assert.equal(projected.retained.size, 0);
});

test("recovery drains in-flight lookup but does not start fallback I/O or later candidates after deadline", async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let lookups = 0; let directoryLookups = 0; let active = 0; let calls = 0;
  const ctx = sessionContext(await temporary(t), "deadline-recovery", {
    getArtifactPath: async () => { lookups++; active++; entered(); await gate; active--; return "/unavailable-epr-probe"; },
    getArtifactsDir: () => { directoryLookups++; return null; },
  });
  const root = runtimeRoot(ctx);
  const reducer = new EvidencePreservingReducer({ ...config, evidencePreservingReducerTimeoutMs: 20 },
    async (...args) => { calls++; return valid(...args); }, quiet);
  const preview = "PASS head\n[…82ln elided…]\n[raw output: artifact://2]";
  const messages = ["a", "b"].map(id => {
    reducer.observe(event(preview, id), root);
    return toolMessage(preview, { toolName: "bash", toolCallId: id });
  });
  let completed = false;
  const pending = reducer.settle(messages, ctx, signal()).then(() => { completed = true; });
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed, false, "settle must drain the uncancellable path lookup");
  } finally { release(); await pending; }
  assert.equal(active, 0); assert.equal(lookups, 1);
  assert.equal(directoryLookups, 0); assert.equal(calls, 0);
  await reducer.settle(messages, ctx, signal());
  assert.equal(lookups, 1);
  assert.deepEqual((await reducer.project(messages, root)).messages, messages);
});

test("concurrent settle claims truncated candidate before artifact lookup", async t => {
  const dir = await temporary(t); const path = join(dir, "2.bash-original.log");
  await writeFile(path, body);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let lookups = 0; let calls = 0;
  const ctx = sessionContext(dir, "concurrent-recovery", {
    getArtifactPath: async () => { lookups++; entered(); await gate; return path; },
  });
  const root = runtimeRoot(ctx);
  const reducer = new EvidencePreservingReducer(config, async (...args) => { calls++; return valid(...args); }, quiet);
  const preview = "PASS head\n[…82ln elided…]\n[raw output: artifact://2]";
  const message = toolMessage(preview, { toolName: "bash", toolCallId: "call-a" });
  reducer.observe(event(preview), root);
  const first = reducer.settle([message], ctx, signal());
  let second: Promise<void> | undefined;
  try {
    await started;
    second = reducer.settle([message], ctx, signal());
    assert.equal(lookups, 1, "the second settle must not start another lookup");
  } finally { release(); await Promise.all([first, second]); }
  assert.equal(calls, 1);
  assert.match(toolText((await reducer.project([message], root)).messages[0]!), /sol_pi_evidence_receipt_v1/);
});

test("large truncated bash output with failure in middle elision recovers beta from session artifact", async t => {
  const dir = await temporary(t);
  const artifactPath = join(dir, "2.bash-original.log");
  const ctx = sessionContext(dir, "session-trunc", {
    getArtifactPath: async (id: string) => (id === "2" ? artifactPath : null),
    getArtifactsDir: () => dir,
  });
  const root = runtimeRoot(ctx);

  // Construct full synthetic 242-line output with alpha (line 41), beta (line 121), gamma (line 201)
  const lines: string[] = [];
  for (let i = 0; i < 240; i++) {
    if (i === 40) lines.push("ERROR target alpha FAILED: expected 4, got 5");
    else if (i === 120) lines.push("ERROR target beta FAILED: expected 8, got 9");
    else if (i === 200) lines.push("TARGET integration-gamma: NOT RUN; requires external service");
    else lines.push(`${String(i).padStart(4, "0")} PASS synthetic arithmetic fixture; deterministic result`);
  }
  const fullText = lines.join("\n") + "\n";
  await writeFile(artifactPath, fullText, "utf8");

  // Construct truncated event content (middle 82 lines elided, including beta)
  const head = lines.slice(0, 80).join("\n");
  const tail = lines.slice(162).join("\n");
  const truncatedBody = `${head}\n[…82ln elided…]\n${tail}\n[raw output: artifact://2]\n\nWall time: 0.17 seconds\n\nCommand exited with code 7\n`;

  const sourceEvent = event(truncatedBody, "call-trunc-1", {
    exitCode: 7,
    meta: {
      truncation: {
        direction: "middle",
        artifactId: "2",
        totalLines: 242,
        outputLines: 160,
        elidedLines: 82,
      },
    },
  });
  const message = toolMessage(truncatedBody, { toolName: "bash", toolCallId: "call-trunc-1", isError: true });

  let reducerSawBeta = false;
  let recordedLogs: Record<string, unknown>[] = [];
  const reducer = new EvidencePreservingReducer(
    config,
    async (_cfg, _cmd, failed, archive, source) => {
      reducerSawBeta = source.includes("ERROR target beta FAILED: expected 8, got 9");
      return {
        provider: "opencode-go", model: "glm-5.3-flash", ok: true, durationMs: 1, attempts: 1, usageComplete: true,
        errorMessage: undefined, stopReason: "stop" as const,
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        outputText: JSON.stringify({
          schema: REDUCER_RECEIPT_SCHEMA,
          source_sha256: archive.hash,
          status: failed ? "failure" : "success",
          uncertain: false,
          evidence: [
            { kind: "failure", quote: "ERROR target alpha FAILED: expected 4, got 5" },
            { kind: "failure", quote: "ERROR target beta FAILED: expected 8, got 9" },
            { kind: "target", quote: "TARGET integration-gamma: NOT RUN; requires external service" },
          ],
        }),
      };
    },
    log => recordedLogs.push(log),
  );

  reducer.observe(sourceEvent, root);
  await reducer.settle([message], ctx, signal());
  const projected = await reducer.project([message], root);
  const projectedMsg = projected.messages[0]!;
  assert.ok(projectedMsg.role === "toolResult");
  assert.equal(projectedMsg.isError, true, "Process exit code / error state must remain intact");

  const receipt = toolText(projectedMsg);
  assert.match(receipt, /status=failure/);
  assert.match(receipt, /ERROR target beta FAILED/);
  assert.match(receipt, /source_lines=241/);

  // Extract source_artifact path from receipt and read it
  const match = /source_artifact=(.+)/.exec(receipt);
  assert.ok(match, "Receipt must cite source_artifact path");
  const archivedSource = await readFile(match[1]!.trim(), "utf8");
  assert.ok(archivedSource.includes("ERROR target beta FAILED: expected 8, got 9"), "Archived file must contain complete beta diagnostic");
  assert.ok(!archivedSource.includes("[…82ln elided…]"), "Archive must not contain elided preview marker");
});

test("eval envelope containing truncated bash output recovers middle failures from artifact", async t => {
  const dir = await temporary(t);
  const artifactPath = join(dir, "5.bash-original.log");
  const ctx = sessionContext(dir, "session-eval-trunc", {
    getArtifactPath: async (id: string) => (id === "5" ? artifactPath : null),
  });
  const root = runtimeRoot(ctx);

  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (i === 100) lines.push("ERROR middle target failed: code 99");
    else lines.push(`${String(i).padStart(4, "0")} PASS synthetic fixture deterministic payload padding`);
  }
  const fullText = lines.join("\n") + "\n";
  await writeFile(artifactPath, fullText, "utf8");

  const head = lines.slice(0, 50).join("\n");
  const tail = lines.slice(150).join("\n");
  const truncatedBash = `${head}\n[…100ln elided…]\n${tail}\n[raw output: artifact://5]\n`;
  const evalEnvelope = JSON.stringify({ text: truncatedBash, exitCode: 1 });

  const reducer = new EvidencePreservingReducer(config, valid, quiet);
  reducer.begin("eval", "outer-eval", root);
  reducer.observe(event(truncatedBash, "child-bash", {
    exitCode: 1,
    meta: { truncation: { artifactId: "5", direction: "middle" } },
  }), root);
  reducer.observe({ ...event(evalEnvelope, "outer-eval"), toolName: "eval" } as ToolResultEvent, root);

  const message = toolMessage(evalEnvelope, { toolName: "eval", toolCallId: "outer-eval", isError: true });
  await reducer.settle([message], ctx, signal());
  const projected = await reducer.project([message], root);
  const parsed = JSON.parse(toolText(projected.messages[0]!));
  assert.match(parsed.text, /sol_pi_evidence_receipt_v1/);
  assert.ok(projected.messages[0]?.role === "toolResult");
  assert.equal(projected.messages[0].isError, true);
});

test("truncated output with unavailable artifact marks incomplete-truncated-source fallback and retains original", async t => {
  const dir = await temporary(t);
  const ctx = sessionContext(dir, "session-unavailable", {
    getArtifactPath: async () => null, // Artifact not found
  });
  const root = runtimeRoot(ctx);

  const truncatedBody = "0000 PASS head\n[…80ln elided…]\n0100 PASS tail\n[raw output: artifact://99]\n";
  const sourceEvent = event(truncatedBody, "call-unavail", {
    exitCode: 7,
    meta: { truncation: { artifactId: "99", direction: "middle" } },
  });
  const message = toolMessage(truncatedBody, { toolName: "bash", toolCallId: "call-unavail", isError: true });

  let modelCalled = false;
  let fallbackLogged = false;
  const reducer = new EvidencePreservingReducer(
    config,
    async () => { modelCalled = true; throw new Error("Must not call reducer on incomplete source"); },
    log => {
      if (log.phase === "fallback" && log.reason === "incomplete-truncated-source") fallbackLogged = true;
    },
  );

  reducer.observe(sourceEvent, root);
  await reducer.settle([message], ctx, signal());

  assert.equal(modelCalled, false, "Reducer model must never be called on incomplete source");
  assert.equal(fallbackLogged, true, "Must log fallback: incomplete-truncated-source");

  const projected = await reducer.project([message], root);
  assert.equal(projected.messages[0], message, "Original message with elision markers must be retained");
  assert.ok(toolText(projected.messages[0]!).includes("[…80ln elided…]"), "Must not pass off truncated preview as receipt");
});

test("corrupted or elided artifact file is rejected and falls back", async t => {
  const dir = await temporary(t);
  const artifactPath = join(dir, "7.bash-original.log");
  const ctx = sessionContext(dir, "session-corrupt", {
    getArtifactPath: async () => artifactPath,
  });
  const root = runtimeRoot(ctx);

  // Artifact file itself is corrupted / still truncated
  await writeFile(artifactPath, "0000 PASS head\n[…50ln elided…]\n0100 PASS tail\n", "utf8");

  const truncatedBody = "0000 PASS head\n[…50ln elided…]\n0100 PASS tail\n[raw output: artifact://7]\n";
  const sourceEvent = event(truncatedBody, "call-corrupt", {
    exitCode: 1,
    meta: { truncation: { artifactId: "7", direction: "middle" } },
  });
  const message = toolMessage(truncatedBody, { toolName: "bash", toolCallId: "call-corrupt", isError: true });

  let fallbackReason: string | undefined;
  const reducer = new EvidencePreservingReducer(
    config,
    async () => { throw new Error("Must not call model"); },
    log => { if (log.phase === "fallback") fallbackReason = log.reason as string; },
  );

  reducer.observe(sourceEvent, root);
  await reducer.settle([message], ctx, signal());

  assert.equal(fallbackReason, "incomplete-truncated-source");
  const projected = await reducer.project([message], root);
  assert.equal(projected.messages[0], message);
});
