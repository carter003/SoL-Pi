/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * OMP adapter derived from SoL-Pi observation-pack/index.ts; see UPSTREAM.md.
 */
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  countLines,
  createObservation,
  ensureStored,
  isObservationId,
  isPureTextResult,
  observationPath,
  placeholderFor,
  readRecallChunk,
} from "../upstream/sol-pi/observation-pack/observation.ts";
import { detectTruncation, resolveArtifactContent } from "./artifact-source.ts";

export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;
const RECALL_LIMITS = { maxBytes: RECALL_MAX_BYTES - 512, maxLines: RECALL_MAX_LINES - 2 };
export function isCompressibleObservation(toolName: string, _input: unknown): boolean {
  return toolName.toLowerCase() !== "obs_recall";
}

/** Re-evaluated on every context event/tool call; never cache the first session. */
export function runtimeRoot(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager;
  const sessionDir = manager.getSessionDir();
  const sessionId = manager.getSessionId();
  if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) {
    throw new Error("sol-omp requires an absolute persistent OMP session directory");
  }
  if (typeof sessionId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionId)) {
    throw new Error("sol-omp requires a safe OMP session id");
  }
  return join(sessionDir, "sol-omp", sessionId);
}

/** Refuse redirected directories below the host-provided storage anchor. */
async function checkArchiveDirectories(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error("Observation runtime root is not absolute");
  for (const path of [dirname(root), root, join(root, "observation-pack"), join(root, "observation-pack", "objects")]) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Observation archive contains a non-directory or a symbolic link");
      }
    } catch (error) {
      // If a parent is absent, all of its children are absent as well. ensureStored
      // creates them, with private modes, before any placeholder can be produced.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

/** Provider-only projection; this never owns or edits session history. */
export class ObservationPack {
  async project(
    messages: AgentMessage[],
    root: string,
    warn: (message: string) => void = message => console.error(message),
    retained?: ReadonlySet<AgentMessage>,
    ctx?: ExtensionContext,
  ): Promise<AgentMessage[]> {
    const projected = [...messages];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || retained?.has(message) || !isPureTextResult(message)
        || !isCompressibleObservation(message.toolName, undefined)) continue;
      try {
        let source = message;
        const truncation = detectTruncation(message);
        if (truncation.isTruncated) {
          // OMP legitimately paginates some tool results (notably read) without
          // creating an artifact. The preview is incomplete, so it must not be
          // archived as though it were the full observation, but this expected
          // host behavior is not an archive failure either.
          if (!truncation.artifactId) continue;
          if (!ctx) throw new Error(`OMP artifact ${truncation.artifactId} cannot be recovered without session context`);
          const full = await resolveArtifactContent(truncation.artifactId, ctx);
          if (!full) throw new Error(`OMP artifact ${truncation.artifactId} is unavailable or incomplete`);
          source = { ...message, content: [{ type: "text", text: full }] };
        }
        const observation = createObservation(source, root);
        if (!observation) continue;
        await checkArchiveDirectories(root);
        await ensureStored(observation);
        projected[index] = { ...message, content: [{ type: "text", text: placeholderFor(observation) }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown archive error";
        warn(`[sol-omp] observation packing failed; original retained: ${reason}`);
      }
    }
    return projected;
  }

  async recall(root: string, id: string, offset = 0, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (typeof id !== "string" || !isObservationId(id)) throw new Error("Invalid observation id");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
    await checkArchiveDirectories(root);
    let chunk;
    try {
      chunk = await readRecallChunk(observationPath(root, id), offset, RECALL_LIMITS);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Unknown observation id in the current session: ${id}`);
      }
      throw error;
    }
    signal?.throwIfAborted();
    const text = [
      `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
      `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
      chunk.text,
    ].join("\n");
    if (Buffer.byteLength(text, "utf8") > RECALL_MAX_BYTES || countLines(text) > RECALL_MAX_LINES) {
      throw new Error("Recall output exceeded its hard limit");
    }
    return {
      content: [{ type: "text" as const, text }],
      details: { id, offset, bytes: chunk.bytes, lines: chunk.lines, nextOffset: chunk.nextOffset, eof: chunk.eof },
    };
  }
}

export function registerObservationPack(api: ExtensionAPI, enabled: boolean, reducer?: {
  project(messages: AgentMessage[], root: string): Promise<{ messages: AgentMessage[]; retained: Set<AgentMessage> }>;
}): void {
  const pack = new ObservationPack();
  const { Type } = api.typebox;
  api.registerTool({
    name: "obs_recall",
    label: "Recall Observation",
    description: "Read an archived tool observation from this session by id and byte offset. Follow next_offset for exact pages.",
    approval: "read",
    loadMode: "essential",
    parameters: Type.Object({
      id: Type.String({ description: "Observation id from a sol-omp placeholder", pattern: "^obs_[a-f0-9]{24}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset; default 0. Prefer returned next_offset." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return pack.recall(runtimeRoot(ctx), params.id, params.offset ?? 0, signal);
    },
  });
  // Retain read-only recall when disabled; do NOT install a context hook.
  if (!enabled && !reducer) return;
  api.on("context", async (event, ctx) => {
    let root: string;
    try {
      root = runtimeRoot(ctx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "session storage unavailable";
      console.error(`[sol-omp] original context retained: ${reason}`);
      return { messages: [...event.messages] };
    }
    const reduced = await reducer?.project(event.messages, root);
    const messages = reduced?.messages ?? event.messages;
    return { messages: enabled ? await pack.project(messages, root, undefined, reduced?.retained, ctx) : messages };
  });
}
