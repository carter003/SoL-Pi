import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { recordValue } from "../upstream/sol-pi/evidence-preserving-reducer/config.ts";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
function emptyTotals() {
  return { requests: 0, attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    knownCostEstimateUsd: 0, usageComplete: true, durationMs: 0, durationComplete: true };
}
type Totals = ReturnType<typeof emptyTotals>;
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function accumulate(totals: Totals, event: Record<string, unknown>): void {
  totals.requests++;
  const attempts = event.attempts;
  if (Number.isSafeInteger(attempts) && (attempts as number) > 0) totals.attempts += attempts as number;
  else totals.usageComplete = false;
  for (const field of TOKEN_FIELDS) {
    const value = recordValue(event.usage, field);
    if (nonnegative(value)) totals[field] += value;
    else totals.usageComplete = false;
  }
  const cost = recordValue(event.cost, "total");
  if (nonnegative(cost)) totals.knownCostEstimateUsd += cost;
  else totals.usageComplete = false;
  if (nonnegative(event.durationMs)) totals.durationMs += event.durationMs;
  else totals.durationComplete = false;
  if (event.usageComplete !== true) totals.usageComplete = false;
}

/** Observed main requests and reducer responses only; no model prices or bill estimates are invented. */
export class UsageLedger {
  private readonly sessions = new Map<string, {
    main: Totals; reducer: Totals; seenMain: Set<string>; seenReducer: Set<string>; startedAt: number; mainStartedAt?: number;
  }>();
  private state(id: string) {
    let state = this.sessions.get(id);
    if (!state) {
      state = { main: emptyTotals(), reducer: emptyTotals(), seenMain: new Set(), seenReducer: new Set(), startedAt: performance.now() };
      this.sessions.set(id, state);
    }
    return state;
  }
  startMain(id: string): void { this.state(id).mainStartedAt = performance.now(); }
  finishMain(id: string, message: unknown): void {
    if (recordValue(message, "role") !== "assistant") return;
    const state = this.state(id);
    const key = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (state.seenMain.has(key)) return;
    state.seenMain.add(key);
    const usage = recordValue(message, "usage");
    const stopReason = recordValue(message, "stopReason");
    accumulate(state.main, { usage, cost: recordValue(usage, "cost"), attempts: 1,
      durationMs: state.mainStartedAt === undefined ? undefined : performance.now() - state.mainStartedAt,
      usageComplete: stopReason !== "error" && stopReason !== "aborted" });
    state.mainStartedAt = undefined;
  }
  recordReducer(event: Record<string, unknown>): void {
    if (event.phase !== "response" || typeof event.session !== "string") return;
    const state = this.state(event.session);
    const key = `${event.toolCallId}\0${event.sourceSha256}`;
    if (state.seenReducer.has(key)) return;
    state.seenReducer.add(key);
    accumulate(state.reducer, event);
  }
  summary(id: string) {
    const state = this.state(id);
    const bucket = (totals: Totals) => ({ ...totals,
      costEstimateUsd: totals.usageComplete ? totals.knownCostEstimateUsd : null });
    const total = emptyTotals();
    for (const field of ["requests", "attempts", ...TOKEN_FIELDS, "knownCostEstimateUsd", "durationMs"] as const) {
      total[field] = state.main[field] + state.reducer[field];
    }
    total.usageComplete = state.main.usageComplete && state.reducer.usageComplete;
    total.durationComplete = state.main.durationComplete && state.reducer.durationComplete;
    return { schema: "sol-omp-usage/1", session: id, scope: "observed-in-this-extension-process",
      elapsedMs: performance.now() - state.startedAt, main: bucket(state.main), reducer: bucket(state.reducer), total: bucket(total) };
  }
}

export function registerUsageTelemetry(api: ExtensionAPI, ledger: UsageLedger): void {
  api.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") ledger.startMain(ctx.sessionManager.getSessionId());
  });
  api.on("message_end", (event, ctx) => {
    try { ledger.finishMain(ctx.sessionManager.getSessionId(), event.message); }
    catch { api.logger.warn("[sol-omp] foreground accounting unavailable"); }
  });
  // Register AFTER the reducer's settle handler so its latest response is included.
  api.on("session_stop", (_event, ctx) => {
    api.logger.info(`SOL_OMP_USAGE=${JSON.stringify(ledger.summary(ctx.sessionManager.getSessionId()))}`);
  });
}
