import assert from "node:assert/strict";
import { test } from "node:test";
import { registerUsageTelemetry, UsageLedger } from "../src/omp/usage.ts";
import { fakeApi, sessionContext } from "./helpers.ts";

const main = { role: "assistant", provider: "test", model: "test", timestamp: 1, stopReason: "stop",
  content: [{ type: "text", text: "PRIVATE_CONTENT_NOT_FOR_TELEMETRY" }],
  usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 3, totalTokens: 133, cost: { total: 0.02 } } };
const response = { session: "a", phase: "response", toolCallId: "call-1", sourceSha256: "source-hash",
  attempts: 2, durationMs: 100, usageComplete: true,
  usage: { input: 200, output: 40, cacheRead: 50, cacheWrite: 0, totalTokens: 290 }, cost: { total: 0.003 } };

test("usage totals include main requests, reducer attempts and cache tokens once, without source content", () => {
  const ledger = new UsageLedger();
  ledger.startMain("a"); ledger.finishMain("a", main); ledger.finishMain("a", main);
  ledger.recordReducer(response); ledger.recordReducer(response);
  const summary = ledger.summary("a");
  assert.equal(summary.main.requests, 1);
  assert.equal(summary.reducer.requests, 1);
  assert.equal(summary.reducer.attempts, 2);
  assert.equal(summary.total.totalTokens, 423);
  assert.equal(summary.total.cacheRead, 70);
  assert.equal(summary.total.cacheWrite, 3);
  assert.ok(Math.abs(summary.total.costEstimateUsd! - 0.023) < 1e-10);
  assert.equal(summary.total.durationComplete, true);
  assert.equal(summary.reducer.durationMs, 100);
  assert.equal(JSON.stringify(summary).includes("PRIVATE_CONTENT"), false);
  assert.equal(ledger.summary("b").total.requests, 0);
});

test("cancelled or unreported usage stays incomplete instead of becoming a zero-cost total", () => {
  const ledger = new UsageLedger();
  ledger.finishMain("a", main);
  ledger.recordReducer({ ...response, cost: null, usage: null, usageComplete: false, attempts: undefined });
  const summary = ledger.summary("a");
  assert.equal(summary.total.usageComplete, false);
  assert.equal(summary.total.costEstimateUsd, null);
  assert.equal(summary.total.knownCostEstimateUsd, 0.02);
  assert.equal(summary.total.durationComplete, false);
  const restarted = new UsageLedger();
  assert.equal(restarted.summary("a").main.requests, 0, "no historical totals are invented after restart");
});

test("the public event hooks report usage after reducer settlement, in the host logger", async t => {
  const fake = await fakeApi(t);
  const ledger = new UsageLedger();
  const ctx = sessionContext(fake.root, "a");
  fake.api.on("session_stop", () => { ledger.recordReducer(response); });
  registerUsageTelemetry(fake.api, ledger);
  await fake.handlers.get("message_start")!({ message: main }, ctx);
  await fake.handlers.get("message_end")!({ message: main }, ctx);
  await fake.handlers.get("session_stop")!({}, ctx);
  assert.equal(fake.logs.info.length, 1);
  const summary = JSON.parse(String(fake.logs.info[0]![0]).slice("SOL_OMP_USAGE=".length));
  assert.equal(summary.total.requests, 2);
  assert.equal(summary.reducer.attempts, 2);
  assert.equal(fake.execCalls(), 0);
});
