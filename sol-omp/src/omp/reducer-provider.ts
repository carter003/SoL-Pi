/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * OMP adaptation of SoL-Pi evidence-preserving-reducer/provider.ts at
 * d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ArchiveObject } from "../upstream/sol-pi/evidence-preserving-reducer/archive.ts";
import type { ReducerConfig } from "../upstream/sol-pi/evidence-preserving-reducer/config.ts";
import { reducerInput, reducerInstructions } from "../upstream/sol-pi/evidence-preserving-reducer/receipt.ts";

export interface ProviderResult {
  readonly errorMessage: string | undefined;
  readonly model: string;
  readonly ok: boolean;
  readonly outputText: string;
  readonly provider: string;
  readonly stopReason: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly durationMs: number;
  readonly attempts: number;
  readonly usageComplete: boolean;
}

/** Await the entire side-channel request; never resolve auth from a Context hook. */
export async function callReducer(
  config: ReducerConfig,
  command: string,
  isError: boolean,
  archive: ArchiveObject,
  body: string,
  context: ExtensionContext,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const started = performance.now();
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal.aborted) relayAbort();
  else signal.addEventListener("abort", relayAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const operationSignal = controller.signal;
  try {
    operationSignal.throwIfAborted();
    const registry = context.modelRegistry;
    const model = registry.find(config.reducerProvider, config.reducerModel);
    if (!model) throw new Error("Reducer model is unavailable");
    const sessionId = context.sessionManager.getSessionId();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let attempts = 0;
    const response = await completeSimple(model, {
      systemPrompt: [reducerInstructions()],
      messages: [{
        role: "user",
        content: [{ type: "text", text: reducerInput(command, isError, archive, body) }],
        timestamp: Date.now(),
      }],
    }, {
      // Use OMP's central resolver so a rejected OAuth bearer is refreshed or
      // rotated according to the host's authentication retry policy.
      apiKey: registry.resolver(model, sessionId),
      cacheRetention: "none",
      maxTokens: Math.min(config.maxOutputTokens, model.maxTokens ?? config.maxOutputTokens),
      sessionId: config.runId,
      statefulResponses: false,
      signal: operationSignal,
      // completeSimple may retry a host-detected thinking loop. Count every
      // completed attempt it exposes, not just the final response.
      onAttempt: message => {
        attempts++;
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        usage.totalTokens += message.usage.totalTokens;
        cost.input += message.usage.cost.input;
        cost.output += message.usage.cost.output;
        cost.cacheRead += message.usage.cost.cacheRead;
        cost.cacheWrite += message.usage.cost.cacheWrite;
        cost.total += message.usage.cost.total;
      },
    });
    const ok = !operationSignal.aborted && (response.stopReason === "stop" || response.stopReason === "length");
    return {
      errorMessage: ok ? undefined : timedOut ? "Reducer request timed out"
        : operationSignal.aborted ? "Reducer request aborted" : "Reducer provider did not complete",
      model: response.model,
      ok,
      outputText: response.content.flatMap(item => item.type === "text" ? [item.text] : []).join(""),
      provider: response.provider,
      stopReason: response.stopReason,
      usage,
      cost,
      durationMs: performance.now() - started,
      attempts,
      usageComplete: ok,
    };
  } catch {
    // Provider errors can contain request bodies, headers, or credentials.
    // No response means no reportable usage; do not invent a zero-cost result.
    throw new DOMException(timedOut ? "Reducer request timed out"
      : operationSignal.aborted ? "Reducer request aborted" : "Reducer request failed",
      timedOut ? "TimeoutError" : operationSignal.aborted ? "AbortError" : "Error");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", relayAbort);
  }
}
