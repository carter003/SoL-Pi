import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import solOmp from "../src/index.ts";
import { ObservationPack, runtimeRoot } from "../src/omp/observation-pack.ts";
import { createObservation, isPureTextResult } from "../src/upstream/sol-pi/observation-pack/observation.ts";
import { fakeApi, sessionContext, toolMessage, toolText } from "./helpers.ts";

test("startup notices use the UI without terminal writes and retain headless diagnostics", async t => {
  const fake = await fakeApi(t);
  const file = join(fake.agent, "sol-omp.json");
  await writeFile(file, JSON.stringify({ version: 1, evidencePreservingReducer: true,
    evidencePreservingReducerProvider: "test-provider", evidencePreservingReducerModel: "test-model" }));
  await solOmp(fake.api);
  const start = fake.handlers.get("session_start")!;
  const notices: { message: string; type: string }[] = [];
  const stderr: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { stderr.push(args); };
  try {
    await start({ type: "session_start" }, { hasUI: true, ui: {
      notify: (message: string, type: string) => notices.push({ message, type }),
    } });
    assert.deepEqual(stderr, [], "interactive startup must not write over the editor");
    assert.deepEqual(notices.map(notice => notice.type), ["info", "warning"]);
    assert.ok(notices[0]!.message.includes(file), "show the effective configuration path");
    assert.ok(notices[1]!.message.includes("test-provider/test-model"), "identify the external reducer route");
    await start({ type: "session_start" }, { hasUI: false, ui: {
      notify: () => assert.fail("headless diagnostics must not use the no-op UI"),
    } });
    assert.deepEqual(stderr, notices.map(notice => [notice.message]));
  } finally {
    console.error = originalError;
  }
});

test("startup does not warn about external reducer usage when it is disabled", async t => {
  const fake = await fakeApi(t); await solOmp(fake.api);
  const notices: string[] = [];
  await fake.handlers.get("session_start")!({ type: "session_start" }, { hasUI: true, ui: {
    notify: (_message: string, type: string) => notices.push(type),
  } });
  assert.deepEqual(notices, ["info"]);
});

 test("fake-API unit test: defaults register only read-only recall, not projection or native overrides", async t => {
  const fake = await fakeApi(t); await solOmp(fake.api);
  assert.deepEqual(fake.tools.map(tool => tool.name), ["obs_recall"]);
  assert.equal(fake.tools[0]!.approval, "read");
  assert.equal(fake.tools[0]!.loadMode, "essential");
  assert.equal(fake.handlers.has("context"), false);
  assert.equal(fake.execCalls(), 0);
});

 test("fake-API unit test: enabled context projection works and re-resolves each session", async t => {
  const fake = await fakeApi(t);
  await writeFile(join(fake.agent, "sol-omp.json"), '{"version":1,"observationPack":true}');
  await solOmp(fake.api);
  const handler = fake.handlers.get("context"); assert.ok(handler);
  const message = toolMessage(); const event = { type: "context", messages: [message] };
  const ctxA = sessionContext(fake.root, "a"); const ctxB = sessionContext(fake.root, "b");
  for (let i = 0; i < 3; i++) assert.match(toolText((await handler(event, ctxA)).messages[0]), /large tool result replaced/);
  assert.match(toolText((await handler(event, ctxB)).messages[0]), /large tool result replaced/);
  assert.deepEqual(fake.tools.map(tool => tool.name), ["obs_recall"]);
  assert.equal(fake.execCalls(), 0);
});

 test("fake-API unit test: missing session storage keeps original context", async t => {
  const fake = await fakeApi(t);
  await writeFile(join(fake.agent, "sol-omp.json"), '{"version":1,"observationPack":true}');
  await solOmp(fake.api);
  const message = toolMessage(); const handler = fake.handlers.get("context"); assert.ok(handler);
  const result = await handler({ type: "context", messages: [message] }, sessionContext("relative"));
  assert.equal(result.messages[0], message);
});

 test("fake-API unit test: disabled packing still restores an existing same-session archive", async t => {
  const fake = await fakeApi(t); const ctx = sessionContext(fake.root); const root = runtimeRoot(ctx);
  const message = toolMessage(); await new ObservationPack().project([message], root);
  assert.ok(isPureTextResult(message)); if (!isPureTextResult(message)) throw new Error("fixture");
  const id = createObservation(message, root)!.id;
  await solOmp(fake.api);
  const result = await fake.tools[0]!.execute("recall-call", { id }, undefined, undefined, ctx);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /obs_recall/);
  assert.equal(fake.handlers.has("context"), false);
});

 test("fake-API unit test: unsupported fusion fails before registration or any command", async t => {
  const fake = await fakeApi(t);
  await writeFile(join(fake.agent, "sol-omp.json"), '{"version":1,"observationPack":true,"actionFusion":true}');
  await assert.rejects(solOmp(fake.api), /Action Fusion is unavailable/);
  assert.equal(fake.tools.length, 0); assert.equal(fake.handlers.size, 0); assert.equal(fake.execCalls(), 0);
});

 test("fake-API unit test: invalid config fails before registration", async t => {
  const fake = await fakeApi(t);
  await writeFile(join(fake.agent, "sol-omp.json"), '{"version":1,"observationPack":"true"}');
  await assert.rejects(solOmp(fake.api), /boolean/);
  assert.equal(fake.tools.length, 0); assert.equal(fake.handlers.size, 0);
});

 test("fake-API unit test: public API capability absence is explicit", async t => {
  const fake = await fakeApi(t);
  const broken = { ...fake.api, pi: {} };
  await assert.rejects(solOmp(broken as typeof fake.api), /injected/);
  assert.equal(fake.tools.length, 0);
});

 test("fake-API unit test: config changes take effect on restart only", async t => {
  const fake = await fakeApi(t); const file = join(fake.agent, "sol-omp.json");
  await writeFile(file, '{"version":1,"observationPack":false}'); await solOmp(fake.api);
  await writeFile(file, '{"version":1,"observationPack":true}');
  assert.equal(fake.handlers.has("context"), false);
  await solOmp(fake.api);
  assert.equal(fake.handlers.has("context"), true);
});
