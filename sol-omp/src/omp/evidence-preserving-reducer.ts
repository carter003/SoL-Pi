/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * OMP session-stop / Context adaptation; see UPSTREAM.md.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { SolOmpConfig } from "../config.ts";
import { archiveBody } from "../upstream/sol-pi/evidence-preserving-reducer/archive.ts";
import { reducibleToolResult } from "../upstream/sol-pi/evidence-preserving-reducer/candidate.ts";
import { isRecord, LIKELY_SECRET, loadReducerConfig, recordValue, sha256 } from "../upstream/sol-pi/evidence-preserving-reducer/config.ts";
import { receiptText, validateReceipt } from "../upstream/sol-pi/evidence-preserving-reducer/receipt.ts";
import { callReducer } from "./reducer-provider.ts";
import { runtimeRoot } from "./observation-pack.ts";

type Message = ContextEvent["messages"][number];
type ToolMessage = Extract<Message, { role: "toolResult" }>;
type Content = ToolResultEvent["content"];
interface Candidate {
  sourceSha256: string;
  toolCallId: string;
  targetId: string;
  command: string;
  body: string;
  observedBody: string;
  isError: boolean;
  isTruncated?: boolean;
  artifactId?: string;
  sourceRecovered?: boolean;
  fallback?: string;
  attempted: boolean;
  receipt?: string;
}
interface Target { hash: string; candidates: Candidate[] }
interface SessionState {
  config: ReturnType<typeof loadReducerConfig>;
  activeEvals: Set<string>;
  candidates: Map<string, Candidate>;
  targets: Map<string, Target>;
}
function text(content: Content): string | undefined {
  return content.length && content.every(block => block.type === "text")
    ? content.map(block => block.type === "text" ? block.text : "").join("\n") : undefined;
}

/** Supplement the unreliable tool_result flag; never write any error field. */
export function resultFailed(event: { isError?: boolean; details?: unknown; content: Content }): boolean {
  const details = event.details;
  const code = recordValue(details, "exitCode");
  return event.isError === true || recordValue(details, "isError") === true || recordValue(details, "hasError") === true
    || (typeof code === "number" && code !== 0)
    || recordValue(details, "timedOut") === true
    || /(?:^|\n)(?:Command exited with code (?!0(?:\s|$))\d+|\[Command cancelled\]|Command timed out)/u.test(text(event.content) ?? "");
}

export function detectTruncation(event: { details?: unknown; content: Content }): { isTruncated: boolean; artifactId?: string } {
  const details = event.details;
  const meta = recordValue(details, "meta");
  const truncation = recordValue(meta, "truncation");
  let isTruncated = false;
  let artifactId: string | undefined;

  if (isRecord(truncation)) {
    isTruncated = true;
    const id = recordValue(truncation, "artifactId");
    if (typeof id === "string" && /^\d+$/.test(id)) artifactId = id;
    else if (typeof id === "number") artifactId = String(id);
  }

  const rawText = text(event.content) ?? "";
  const rawMatch = /(?:^|\n)\[raw output: artifact:\/\/(\d+)\]/u.exec(rawText);
  if (rawMatch) {
    isTruncated = true;
    artifactId ??= rawMatch[1];
  }
  const readMatch = /Read artifact:\/\/(\d+) for full output/u.exec(rawText);
  if (readMatch) {
    isTruncated = true;
    artifactId ??= readMatch[1];
  }
  if (
    /(?:^|\n)\[…(?:\d+ln|\d+B) elided…\]/u.test(rawText) ||
    /(?:^|\n)\[Showing lines \d+-\d+ of \d+/u.test(rawText) ||
    /(?:^|\n)\[Showing \d+ of \d+ lines; middle elided\]/u.test(rawText)
  ) {
    isTruncated = true;
  }

  return { isTruncated, artifactId };
}

export function isValidFullArtifact(content: string): boolean {
  if (!content || content.length === 0) return false;
  if (/(?:^|\n)\[…(?:\d+ln|\d+B) elided…\]/u.test(content)) return false;
  if (/\[ARTIFACT TRUNCATED:/u.test(content)) return false;
  return true;
}

export async function resolveArtifactContent(
  artifactId: string, ctx: ExtensionContext, signal: AbortSignal, deadline: number,
): Promise<string | undefined> {
  const expired = () => signal.aborted || performance.now() >= deadline;
  if (expired() || !ctx.sessionManager) return undefined;
  const sm = ctx.sessionManager as unknown as Record<string, unknown>;
  try {
    if (typeof sm.getArtifactPath === "function") {
      // The host lookup has no signal parameter: drain it, then recheck before reading.
      const artifactPath = await (sm.getArtifactPath as (id: string) => Promise<string | null>)(artifactId);
      if (expired()) return undefined;
      if (typeof artifactPath === "string" && artifactPath) {
        const content = await readFile(artifactPath, { encoding: "utf8", signal });
        if (expired()) return undefined;
        if (isValidFullArtifact(content)) return content;
      }
    }
  } catch {}

  if (expired()) return undefined;
  try {
    if (typeof sm.getArtifactsDir === "function") {
      const dir = (sm.getArtifactsDir as () => string | null)();
      if (expired()) return undefined;
      if (typeof dir === "string" && dir) {
        const entries = await readdir(dir);
        if (expired()) return undefined;
        const match = entries.find(f => f.startsWith(`${artifactId}.`));
        if (expired()) return undefined;
        if (match) {
          const content = await readFile(join(dir, match), { encoding: "utf8", signal });
          if (expired()) return undefined;
          if (isValidFullArtifact(content)) return content;
        }
      }
    }
  } catch {}

  return undefined;
}

/** In-memory, session/tool/hash keyed. No jobs, retries, continuation, or history mutation. */
export class EvidencePreservingReducer {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly config: SolOmpConfig, private readonly invoke = callReducer,
    private readonly log: (event: Record<string, unknown>) => void = event => console.error(`SOL_OMP_EPR=${JSON.stringify(event)}`)) {}

  private state(root: string): SessionState {
    let state = this.sessions.get(root);
    if (!state) {
      state = { activeEvals: new Set(), candidates: new Map(), targets: new Map(), config: {
        ...loadReducerConfig(root, { reducerProvider: this.config.evidencePreservingReducerProvider, reducerModel: this.config.evidencePreservingReducerModel }),
        timeoutMs: this.config.evidencePreservingReducerTimeoutMs,
      } };
      this.sessions.set(root, state);
    }
    return state;
  }
  begin(toolName: string, toolCallId: string, root: string): void {
    if (toolName === "eval") this.state(root).activeEvals.add(toolCallId);
  }
  observe(event: ToolResultEvent, root: string): void {
    const state = this.state(root);
    if (event.toolName === "eval") {
      state.activeEvals.delete(event.toolCallId);
      const body = text(event.content);
      if (body === undefined) return;
      const candidates = [...state.candidates.values()].filter(candidate => candidate.targetId === event.toolCallId);
      if (candidates.length) state.targets.set(event.toolCallId, { hash: sha256(body), candidates });
      return;
    }
    const reducible = reducibleToolResult(event);
    if (!reducible) return;
    const truncation = detectTruncation(event);
    if (!truncation.isTruncated && Buffer.byteLength(reducible.body, "utf8") < state.config.minBytes) return;
    const targetId = state.activeEvals.size === 1 ? [...state.activeEvals][0]! : event.toolCallId;
    const observedBody = reducible.body;
    const key = `${event.toolCallId}\0${sha256(observedBody)}`;
    if (state.candidates.has(key)) return;
    const details = event.details;
    const failed = resultFailed(event);
    const candidate: Candidate = {
      sourceSha256: sha256(observedBody),
      toolCallId: event.toolCallId,
      targetId,
      command: reducible.command,
      body: observedBody,
      observedBody,
      isError: failed,
      isTruncated: truncation.isTruncated,
      artifactId: truncation.artifactId,
      sourceRecovered: !truncation.isTruncated,
      attempted: false,
      fallback: state.activeEvals.size > 1 ? "ambiguous-eval-parent"
        : recordValue(details, "timedOut") === true ? "tool-timeout"
        : recordValue(recordValue(details, "async"), "state") !== undefined ? "async-tool-result"
        : undefined,
    };

    // tool_result has no run signal: collect synchronously; recover only during settle.
    state.candidates.set(key, candidate);
    if (targetId === event.toolCallId) state.targets.set(targetId, { hash: sha256(observedBody), candidates: [candidate] });
  }

  /** OMP 18.1.18 allows 30s per handler; reserve 5s for abort/drain. */
  async settle(messages: Message[], ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
    const budgetMs = Math.min(25_000, this.config.evidencePreservingReducerTimeoutMs);
    const deadline = performance.now() + budgetMs;
    const timer = setTimeout(() => controller.abort(new DOMException("EPR settle budget exhausted", "TimeoutError")), budgetMs);
    try {
      // Await cancellation completion; a race would leave the request running.
      await this.settleBeforeDeadline(messages, ctx, controller.signal, deadline);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
    }
  }

  private async settleBeforeDeadline(messages: Message[], ctx: ExtensionContext, signal: AbortSignal, deadline: number): Promise<void> {
    const expired = () => signal.aborted || performance.now() >= deadline;
    const abortReason = () => signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      || (!signal.aborted && performance.now() >= deadline) ? "settle-timeout" : "cancelled";
    const root = runtimeRoot(ctx);
    const state = this.state(root);
    state.activeEvals.clear();
    const present = new Map(messages.filter((message): message is ToolMessage => message.role === "toolResult")
      .map(message => [message.toolCallId, message]));
    for (const candidate of state.candidates.values()) {
      if (candidate.attempted) continue;
      // Claim before the first await, including recovery, so concurrent settle cannot duplicate work.
      candidate.attempted = true;
      const identity = { session: ctx.sessionManager.getSessionId(), toolCallId: candidate.toolCallId,
        targetId: candidate.targetId, sourceSha256: candidate.sourceSha256 };
      const fallback = (reason: string) => { candidate.fallback = reason; this.log({ ...identity, phase: "fallback", reason }); };
      if (expired()) { fallback(abortReason()); continue; }
      if (candidate.fallback) { fallback(candidate.fallback); continue; }
      const message = present.get(candidate.targetId);
      const target = state.targets.get(candidate.targetId);
      const messageText = message && text(message.content);
      if (!message || !target || messageText === undefined || sha256(messageText) !== target.hash
        || !this.replaceBody(messageText, candidate.observedBody, "receipt-probe")) {
        fallback("source-not-in-current-observation"); continue;
      }
      if (expired()) { fallback(abortReason()); continue; }
      if (candidate.isTruncated && !candidate.sourceRecovered) {
        const full = candidate.artifactId
          ? await resolveArtifactContent(candidate.artifactId, ctx, signal, deadline) : undefined;
        if (expired()) { fallback(abortReason()); continue; }
        if (!full) { fallback("incomplete-truncated-source"); continue; }
        candidate.body = full;
        candidate.sourceSha256 = sha256(full);
        identity.sourceSha256 = candidate.sourceSha256;
        candidate.sourceRecovered = true;
      }
      const rejection = Buffer.byteLength(candidate.body, "utf8") < state.config.minBytes ? "source-under-min-bytes"
        : LIKELY_SECRET.test(candidate.body) ? "likely-secret"
        : candidate.body.length > state.config.maxChars ? "source-over-max-chars"
        : !candidate.isError && /(?:^|\n)(?:ERROR|FAIL(?:ED)?|FATAL|panic|Exception)\b/iu.test(candidate.body) ? "ambiguous-failure-status"
        : undefined;
      if (rejection) { fallback(rejection); continue; }
      if (expired()) { fallback(abortReason()); continue; }
      const config = state.config;
      try {
        const archive = await archiveBody(config.storeRoot, candidate.body);
        if (expired()) { fallback(abortReason()); continue; }
        this.log({ ...identity, phase: "request", sourceBytes: archive.bytes, provider: config.reducerProvider, model: config.reducerModel });
        const start = performance.now();
        let response;
        try { response = await this.invoke(config, candidate.command, candidate.isError, archive, candidate.body, ctx, signal); }
        catch (error) {
          this.log({ ...identity, phase: "response", durationMs: performance.now() - start, usage: null, cost: null });
          fallback(expired() ? abortReason() : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "provider-exception");
          continue;
        }
        this.log({ ...identity, phase: "response", provider: response.provider, model: response.model,
          durationMs: response.durationMs, stopReason: response.stopReason, usage: response.usage, cost: response.cost,
          attempts: response.attempts, usageComplete: response.usageComplete });
        if (expired()) { fallback(abortReason()); continue; }
        if (!response.ok) { fallback(response.errorMessage === "Reducer request timed out" ? "timeout" : "provider-error"); continue; }
        const checked = validateReceipt(response.outputText, archive, candidate.body, candidate.isError);
        if (!checked.ok) { fallback(checked.reason); continue; }
        const receipt = receiptText(candidate.command, archive, checked.value, response);
        if (Buffer.byteLength(receipt, "utf8") >= archive.bytes) { fallback("receipt-not-smaller"); continue; }
        // Recheck disk, including existing-object integrity, before caching a projection.
        await archiveBody(config.storeRoot, candidate.body);
        if (expired()) { fallback(abortReason()); continue; }
        candidate.receipt = receipt;
        this.log({ ...identity, phase: "verified", sourceBytes: archive.bytes, receiptBytes: Buffer.byteLength(receipt, "utf8"),
          status: checked.value.status, uncertain: checked.value.uncertain, evidence: checked.value.evidence });
      } catch { fallback(expired() ? abortReason() : "archive-or-validation-error"); }
    }
  }

  private replaceBody(value: string, body: string, replacement: string): string | undefined {
    // Native eval may display text or JSON. Only one exact contiguous occurrence is eligible.
    const forms = [[body, replacement], [JSON.stringify(body).slice(1, -1), JSON.stringify(replacement).slice(1, -1)]];
    for (const [needle, output] of forms) {
      if (!needle || output === undefined) continue;
      const index = value.indexOf(needle);
      if (index >= 0 && value.indexOf(needle, index + needle.length) < 0)
        return value.slice(0, index) + output + value.slice(index + needle.length);
    }
    return undefined;
  }

  async project(messages: Message[], root: string): Promise<{ messages: Message[]; retained: Set<Message> }> {
    const state = this.state(root);
    const retained = new Set<Message>();
    const projectedMessages = [...messages];
    projection: for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || message.role !== "toolResult") continue;
      const target = state.targets.get(message.toolCallId);
      if (!target) {
        // Unknown/restarted bash and eval may hide failed/sensitive diagnostics; fail open.
        if (message.toolName === "bash" || message.toolName === "eval") retained.add(message);
        continue;
      }
      const original = text(message.content);
      if (original === undefined || sha256(original) !== target.hash || target.candidates.some(candidate => !candidate.receipt)) {
        retained.add(message); continue;
      }
      let projected = original;
      for (const candidate of target.candidates) {
        try { await archiveBody(state.config.storeRoot, candidate.body); }
        catch { retained.add(message); continue projection; }
        const next = this.replaceBody(projected, candidate.observedBody, candidate.receipt!);
        if (next === undefined) { retained.add(message); continue projection; }
        projected = next;
      }
      const result = { ...message, content: [{ type: "text" as const, text: projected }] };
      retained.add(result); // Includes receipts inside JSON-escaped eval envelopes.
      projectedMessages[index] = result;
    }
    return { messages: projectedMessages, retained };
  }
}

export function registerEvidencePreservingReducer(api: ExtensionAPI, config: SolOmpConfig): EvidencePreservingReducer | undefined {
  if (!config.evidencePreservingReducer) return undefined;
  const reducer = new EvidencePreservingReducer(config);
  const withRoot = (ctx: ExtensionContext, fn: (root: string) => void) => {
    try { fn(runtimeRoot(ctx)); } catch { console.error("[sol-omp] EPR storage unavailable; original retained"); }
  };
  api.on("tool_call", (event, ctx) => { withRoot(ctx, root => reducer.begin(event.toolName, event.toolCallId, root)); });
  api.on("tool_result", (event, ctx) => { withRoot(ctx, root => reducer.observe(event, root)); });
  api.on("session_stop", async (event, ctx) => {
    try { await reducer.settle(event.messages, ctx, event.signal); }
    catch { console.error("[sol-omp] EPR settle failed; original retained"); }
    // No continuation, abort, rewriting, or background task.
  });
  return reducer;
}