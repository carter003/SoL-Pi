import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_EPR_RECEIPT_PREFIX } from "../src/codex/evidence-reducer.ts";
import {
  projectObservationRoot,
  projectRootForCwd,
  readObservationChunk,
  readObservationMeta,
  searchObservation,
} from "../src/codex/observation-store.ts";
import {
  CODEX_OBSERVATION_THRESHOLD_BYTES,
  extractStructuredExitCode,
  handlePostToolUse,
  isCompressibleDiagnosticCommand,
  isRecallCommand,
} from "../src/codex/post-tool-use.ts";
import { temporary } from "./helpers.ts";

function input(output: unknown, command = "npm test") {
  return {
    hook_event_name: "PostToolUse",
    session_id: "session-codex",
    turn_id: "turn-codex",
    tool_name: "Bash",
    tool_use_id: "call-codex",
    tool_input: { command },
    tool_response: output,
  };
}

function largeFailure(): string {
  const lines = Array.from({ length: 220 }, (_, index) => `${index}: routine compiler progress`);
  lines[73] = "src/parser.ts:42:7 ERROR expected token ';' but actual token '}'";
  lines[74] = "    at parseModule (src/parser.ts:42:7)";
  lines.push("Tests: 1 failed, 19 passed", "Process exited with code 1");
  return `${lines.join("\n")}\n${"padding-line\n".repeat(300)}`;
}

test("Codex output below 4 KiB remains entirely on the native path", async t => {
  const root = await temporary(t);
  const result = await handlePostToolUse(input("x".repeat(CODEX_OBSERVATION_THRESHOLD_BYTES - 1)), { root });
  assert.equal(result, undefined);
  assert.equal((await stat(root)).isDirectory(), true);
  assert.deepEqual(await readdir(root), []);
});

test("user-wide observations are isolated by canonical project root", async t => {
  const base = await temporary(t);
  const first = join(base, "first");
  const firstChild = join(first, "packages", "app");
  const second = join(base, "second");
  await mkdir(join(first, ".git"), { recursive: true });
  await mkdir(firstChild, { recursive: true });
  await mkdir(join(second, ".git"), { recursive: true });

  assert.equal(projectRootForCwd(firstChild), first);
  assert.equal(projectObservationRoot(first, base), projectObservationRoot(firstChild, base));
  assert.notEqual(projectObservationRoot(first, base), projectObservationRoot(second, base));
  assert.match(projectObservationRoot(first, base), /\/projects\/[a-f0-9]{64}$/u);
});

test("large Codex output is archived and replaced by a verified EPR receipt", async t => {
  const root = await temporary(t);
  const raw = largeFailure();
  const result = await handlePostToolUse(input({ output: raw, exitCode: 1 }), { root, now: new Date("2026-09-14T00:00:00.000Z") });
  assert.ok(result);
  assert.equal(result.decision, "block");
  assert.match(result.reason, new RegExp(`^${CODEX_EPR_RECEIPT_PREFIX}`));
  assert.match(result.reason, /src\/parser\.ts:42:7 ERROR expected token/);
  assert.match(result.reason, /status_source=tool-response-metadata/);
  assert.match(result.reason, /exit_code=1/);
  assert.equal(result.reason.includes("routine compiler progress\n1:"), false);
  assert.ok(Buffer.byteLength(result.reason) < Buffer.byteLength(raw));

  const id = /observation_id=(obs_[a-f0-9]{24})/u.exec(result.reason)?.[1];
  assert.ok(id);
  const meta = await readObservationMeta(root, id);
  assert.equal(meta.rawBytes, Buffer.byteLength(raw));
  assert.equal(meta.rawSha256.length, 64);
  assert.equal(meta.captureComplete, "unknown");
  assert.equal(meta.exitCode, 1);
  assert.equal(meta.exitCodeAvailable, true);
  assert.ok(meta.reducedBytes && meta.reducedBytes > 0);
  assert.equal(await readFile(join(root, id, "raw.txt"), "utf8"), raw);
  assert.equal(await readFile(join(root, id, "reduced.txt"), "utf8"), result.reason);

  const found = await searchObservation(root, id, "ERROR", 1);
  assert.match(found, /73: 72: routine compiler progress/);
  assert.match(found, /74: src\/parser\.ts:42:7 ERROR/);
  const chunk = await readObservationChunk(root, id, 0, 256);
  assert.equal(Buffer.byteLength(chunk.text), chunk.bytes);
  assert.ok(chunk.nextOffset > 0);
});

test("threshold is inclusive and recall commands never recursively pack", async t => {
  const root = await temporary(t);
  const result = await handlePostToolUse(input("x".repeat(CODEX_OBSERVATION_THRESHOLD_BYTES)), { root });
  assert.ok(result);
  for (const command of [
    "sol observation read obs_aaaaaaaaaaaaaaaaaaaaaaaa --offset 0",
    "bun src/codex/cli.ts observation search obs_aaaaaaaaaaaaaaaaaaaaaaaa --query FAIL",
  ]) {
    assert.equal(isRecallCommand(command), true);
    assert.equal(await handlePostToolUse(input(largeFailure(), command), { root }), undefined);
  }
});

test("exit status accepts only structured tool-response metadata", () => {
  assert.equal(extractStructuredExitCode({ output: "anything", exitCode: 7 }), 7);
  assert.equal(extractStructuredExitCode({ output: "anything", details: { exit_code: 0 } }), 0);
  assert.equal(extractStructuredExitCode("Process exited with code 7"), null);
  assert.equal(extractStructuredExitCode({ output: '{"exitCode":1}' }), null);
});

test("unknown exit status stays unknown instead of turning evidence inference into success", async t => {
  const root = await temporary(t);
  const raw = `${"ordinary output\n".repeat(400)}Warning: truncated output`;
  const result = await handlePostToolUse(input(raw), { root });
  assert.ok(result);
  assert.match(result.reason, /status=unknown/);
  assert.match(result.reason, /status_source=unavailable/);
  assert.match(result.reason, /exit_code=unknown/);
});

test("dense source, documentation, config, diff, and search output stays on the native path", async t => {
  const root = await temporary(t);
  const dense = `${"export const value: string = \"important\";\n".repeat(200)}`;
  for (const command of [
    "sed -n '1,240p' src/index.ts",
    "cat README.md",
    "rg -n 'important' src",
    "jq . package.json",
    "git diff -- src/index.ts",
    "cat src/index.ts && npm test",
  ]) {
    assert.equal(isCompressibleDiagnosticCommand(command), false, command);
    assert.equal(await handlePostToolUse(input(dense, command), { root }), undefined, command);
  }
  assert.deepEqual(await readdir(root), []);
});

test("only explicit low-density diagnostic commands are eligible", () => {
  for (const command of ["npm test", "cd app && bun test", "pnpm run typecheck", "cargo clippy", "docker logs api"]) {
    assert.equal(isCompressibleDiagnosticCommand(command), true, command);
  }
  for (const command of ["printf lots-of-text", "ls -la", "wc -l src/index.ts", "git status --short"]) {
    assert.equal(isCompressibleDiagnosticCommand(command), false, command);
  }
});

test("source-like exitCode text never becomes process status", async t => {
  const root = await temporary(t);
  const raw = `${"routine test output\n".repeat(300)}process.exitCode = 1;\nclass Blocked extends Error {}`;
  const result = await handlePostToolUse(input(raw, "bun test"), { root });
  assert.ok(result);
  assert.match(result.reason, /status=unknown/);
  assert.match(result.reason, /status_source=unavailable/);
  assert.match(result.reason, /exit_code=unknown/);
});
