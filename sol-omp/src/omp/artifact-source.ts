/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * OMP artifact recovery shared by context projection and the evidence reducer.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { isRecord, recordValue } from "../upstream/sol-pi/evidence-preserving-reducer/config.ts";

type Content = ToolResultEvent["content"];

function text(content: Content): string | undefined {
  return content.length > 0 && content.every(block => block.type === "text")
    ? content.map(block => block.type === "text" ? block.text : "").join("\n")
    : undefined;
}

export function detectTruncation(event: { details?: unknown; content: Content }): { isTruncated: boolean; artifactId?: string } {
  const meta = recordValue(event.details, "meta");
  const truncation = recordValue(meta, "truncation");
  let isTruncated = false;
  let artifactId: string | undefined;

  if (isRecord(truncation)) {
    isTruncated = true;
    const id = recordValue(truncation, "artifactId");
    if (typeof id === "string" && /^\d+$/.test(id)) artifactId = id;
    else if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) artifactId = String(id);
  }

  const rawText = text(event.content) ?? "";
  for (const pattern of [/(?:^|\n)\[raw output: artifact:\/\/(\d+)\]/u, /Read artifact:\/\/(\d+) for full output/u]) {
    const match = pattern.exec(rawText);
    if (match) {
      isTruncated = true;
      artifactId ??= match[1];
    }
  }
  if (/(?:^|\n)\[…(?:\d+ln|\d+B) elided…\]/u.test(rawText)
    || /(?:^|\n)\[Showing lines \d+-\d+ of \d+/u.test(rawText)
    || /(?:^|\n)\[Showing \d+ of \d+ lines; middle elided\]/u.test(rawText)) isTruncated = true;

  return { isTruncated, artifactId };
}

export function isValidFullArtifact(content: string): boolean {
  return content.length > 0
    && !/(?:^|\n)\[…(?:\d+ln|\d+B) elided…\]/u.test(content)
    && !/\[ARTIFACT TRUNCATED:/u.test(content);
}

export function candidateArtifactDirectories(manager: ExtensionContext["sessionManager"]): string[] {
  const dirs: string[] = [];
  if ("getArtifactsDir" in manager && typeof manager.getArtifactsDir === "function") {
    try {
      const dir = manager.getArtifactsDir();
      if (typeof dir === "string" && dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
    } catch {}
  }
  if ("getArtifactManager" in manager && typeof manager.getArtifactManager === "function") {
    try {
      const artifactManager = manager.getArtifactManager();
      if (artifactManager && typeof artifactManager === "object" && "dir" in artifactManager && typeof artifactManager.dir === "string" && artifactManager.dir.length > 0 && !dirs.includes(artifactManager.dir)) {
        dirs.push(artifactManager.dir);
      }
    } catch {}
  }
  if ("getSessionFile" in manager && typeof manager.getSessionFile === "function") {
    try {
      const sessionFile = manager.getSessionFile();
      if (typeof sessionFile === "string" && sessionFile.endsWith(".jsonl")) {
        const dir = sessionFile.slice(0, -6);
        if (dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
      }
    } catch {}
  }
  return dirs;
}

export async function resolveArtifactContent(
  artifactId: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
): Promise<string | undefined> {
  const expired = () => signal?.aborted === true || performance.now() >= deadline;
  if (expired()) return undefined;
  const manager = ctx.sessionManager;

  const tryRead = async (targetPath: string): Promise<string | undefined> => {
    try {
      if (expired()) return undefined;
      const content = signal
        ? await readFile(targetPath, { encoding: "utf8", signal })
        : await readFile(targetPath, "utf8");
      if (!expired() && isValidFullArtifact(content)) return content;
    } catch {}
    return undefined;
  };

  try {
    const artifactPath = await manager.getArtifactPath(artifactId);
    if (expired()) return undefined;
    if (artifactPath) {
      const content = await tryRead(artifactPath);
      if (content) return content;
    }
  } catch {}

  if (expired()) return undefined;

  const candidateDirs = candidateArtifactDirectories(manager);
  for (const directory of candidateDirs) {
    if (expired()) return undefined;
    try {
      const entries = await readdir(directory);
      if (expired()) return undefined;
      const match = entries.find(name => name.startsWith(`${artifactId}.`));
      if (match) {
        const content = await tryRead(join(directory, match));
        if (content) return content;
      }
    } catch {}
  }

  if (!expired() && candidateDirs.length > 0 && performance.now() + 25 < deadline) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 20);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (expired()) return undefined;

    try {
      const artifactPath = await manager.getArtifactPath(artifactId);
      if (artifactPath) {
        const content = await tryRead(artifactPath);
        if (content) return content;
      }
    } catch {}

    for (const directory of candidateDirs) {
      if (expired()) return undefined;
      try {
        const entries = await readdir(directory);
        if (expired()) return undefined;
        const match = entries.find(name => name.startsWith(`${artifactId}.`));
        if (match) {
          const content = await tryRead(join(directory, match));
          if (content) return content;
        }
      } catch {}
    }
  }

  return undefined;
}
