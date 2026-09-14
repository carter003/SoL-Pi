#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { handlePostToolUse } from "./post-tool-use.ts";
import {
  defaultObservationRoot,
  readObservationChunk,
  readObservationMeta,
  readWholeObservation,
  searchObservation,
} from "./observation-store.ts";
import { installCodexUser } from "./user-install.ts";

const MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024;

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error("Hook input exceeds 2 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

async function postToolUse(): Promise<void> {
  try {
    const value = JSON.parse(await stdinText()) as unknown;
    const result = await handlePostToolUse(value && typeof value === "object" ? value : {});
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Fail open without echoing a tool response or provider/credential error.
    process.stderr.write("[sol-codex] PostToolUse processing failed; original result retained\n");
  }
}

async function observation(args: string[]): Promise<void> {
  const action = args[0];
  const id = args[1];
  if (!id || !["meta", "read", "search"].includes(action ?? "")) {
    throw new Error("Usage: sol observation <meta|read|search> <id> [options]");
  }
  const parsed = parseArgs({
    args: args.slice(2),
    options: {
      offset: { type: "string" },
      "max-bytes": { type: "string" },
      query: { type: "string" },
      "context-lines": { type: "string" },
      all: { type: "boolean" },
    },
    strict: true,
  });
  const root = defaultObservationRoot();
  if (action === "meta") {
    process.stdout.write(`${JSON.stringify(await readObservationMeta(root, id), null, 2)}\n`);
    return;
  }
  if (action === "read") {
    if (parsed.values.all) {
      process.stdout.write(await readWholeObservation(root, id));
      return;
    }
    const offset = integer(parsed.values.offset, 0);
    const maxBytes = integer(parsed.values["max-bytes"], 12_000);
    if (maxBytes < 4 || maxBytes > 64 * 1024) throw new Error("max-bytes must be between 4 and 65536");
    const chunk = await readObservationChunk(root, id, offset, maxBytes);
    process.stdout.write([
      `observation_id=${id}`,
      `offset=${offset}`,
      `bytes=${chunk.bytes}`,
      `next_offset=${chunk.nextOffset}`,
      `eof=${chunk.eof}`,
      "content:",
      chunk.text,
    ].join("\n"));
    return;
  }
  const query = parsed.values.query;
  if (!query) throw new Error("search requires --query <text>");
  process.stdout.write(`${await searchObservation(root, id, query, integer(parsed.values["context-lines"], 3))}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "codex" && args[1] === "post-tool-use") return postToolUse();
  if (args[0] === "codex" && args[1] === "install-user") {
    const result = await installCodexUser();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === "observation") return observation(args.slice(1));
  throw new Error("Usage: sol codex <post-tool-use|install-user> | sol observation <meta|read|search> ...");
}

main().catch(error => {
  process.stderr.write(`[sol-codex] ${error instanceof Error ? error.message : "command failed"}\n`);
  process.exitCode = 1;
});
