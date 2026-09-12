import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { archiveBody, type ArchiveObject } from "../src/upstream/sol-pi/evidence-preserving-reducer/archive.ts";
import { reducibleToolResult } from "../src/upstream/sol-pi/evidence-preserving-reducer/candidate.ts";
import { REDUCER_RECEIPT_SCHEMA, sha256 } from "../src/upstream/sol-pi/evidence-preserving-reducer/config.ts";
import { validateReceipt } from "../src/upstream/sol-pi/evidence-preserving-reducer/receipt.ts";
import { temporary } from "./helpers.ts";

const BODY = "compiling synthetic target\nerror: 类型不匹配\n  expected integer\nfailed synthetic target\n";
const QUOTE = "error: 类型不匹配\n  expected integer";
const ARCHIVE: ArchiveObject = {
  hash: sha256(BODY), bytes: Buffer.byteLength(BODY), chars: BODY.length,
  lines: BODY.split("\n").length, path: "/synthetic/source.txt",
};

function rawReceipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA, source_sha256: ARCHIVE.hash,
    status: "failure", uncertain: false,
    evidence: [{ kind: "failure", quote: QUOTE }], ...overrides,
  });
}

function storeRoot(directory: string): string {
  return join(directory, "sol-omp", "session-a", "evidence-preserving-reducer");
}

test("receipt rejects a tampered source hash", () => {
  assert.equal(validateReceipt(rawReceipt({ source_sha256: sha256("different source") }), ARCHIVE, BODY, true).ok, false);
});

test("receipt rejects invented or normalized quotes instead of accepting a paraphrase", () => {
  for (const quote of ["error: invented diagnostic", "error: 类型不匹配 expected integer"]) {
    assert.equal(validateReceipt(rawReceipt({ evidence: [{ kind: "failure", quote }] }), ARCHIVE, BODY, true).ok, false);
  }
});

test("receipt status must agree with the observed exit in both directions", () => {
  assert.equal(validateReceipt(rawReceipt({ status: "success" }), ARCHIVE, BODY, true).ok, false);
  assert.equal(validateReceipt(rawReceipt(), ARCHIVE, BODY, false).ok, false);
});

test("failure logs cannot be accepted with missing or summary-only failure evidence", () => {
  for (const evidence of [[], [{ kind: "summary", quote: "compiling synthetic target" }]]) {
    assert.equal(validateReceipt(rawReceipt({ evidence }), ARCHIVE, BODY, true).ok, false);
  }
});

test("verified evidence preserves exact Unicode multiline quotes, line locations and hashes", () => {
  const result = validateReceipt(rawReceipt({ evidence: [
    { kind: "failure", quote: QUOTE },
    { kind: "failure", quote: QUOTE },
    { kind: "target", quote: "failed synthetic target" },
  ] }), ARCHIVE, BODY, true);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    status: "failure", uncertain: false,
    evidence: [
      { kind: "failure", quote: QUOTE, line: 2,
        quoteSha256: createHash("sha256").update(QUOTE, "utf8").digest("hex") },
      { kind: "target", quote: "failed synthetic target", line: 4,
        quoteSha256: createHash("sha256").update("failed synthetic target", "utf8").digest("hex") },
    ],
  });
});

test("archive writes exact private UTF-8 content and reuses only the identical object", async t => {
  const root = storeRoot(await temporary(t));
  const archived = await archiveBody(root, BODY);
  assert.deepEqual(await readFile(archived.path), Buffer.from(BODY));
  assert.equal(archived.hash, createHash("sha256").update(await readFile(archived.path)).digest("hex"));
  assert.equal(archived.bytes, Buffer.byteLength(BODY));
  assert.equal((await stat(archived.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(archived.path))).mode & 0o777, 0o700);
  assert.deepEqual(await archiveBody(root, BODY), archived);
});

test("archive refuses same-sized corrupted objects without overwriting the evidence", async t => {
  const root = storeRoot(await temporary(t));
  const archived = await archiveBody(root, BODY);
  const corrupted = Buffer.from(BODY);
  corrupted[0] = 0x58;
  await writeFile(archived.path, corrupted);
  await assert.rejects(archiveBody(root, BODY));
  assert.deepEqual(await readFile(archived.path), corrupted);
});

test("archive compares raw bytes even when corrupt UTF-8 decodes to the original text", async t => {
  const root = storeRoot(await temporary(t));
  const body = "synthetic \uFFFD\uFFFD\uFFFD";
  const archived = await archiveBody(root, body);
  const corrupt = Buffer.concat([Buffer.from("synthetic "), Buffer.from([0xf0, 0x90, 0x80, 0xf0, 0x90, 0x80, 0xf0, 0x90, 0x80])]);
  assert.equal(corrupt.toString("utf8"), body);
  assert.equal(corrupt.length, archived.bytes);
  await writeFile(archived.path, corrupt);
  await assert.rejects(archiveBody(root, body));
  assert.deepEqual(await readFile(archived.path), corrupt);
});

for (const level of ["adapter", "session", "reducer", "objects", "shard"] as const) {
  test(`archive refuses a symlink at the ${level} directory without writing outside its root`, async t => {
    const directory = await temporary(t);
    const root = storeRoot(directory);
    const paths = {
      adapter: dirname(dirname(root)), session: dirname(root), reducer: root,
      objects: join(root, "objects"), shard: join(root, "objects", sha256(BODY).slice(0, 2)),
    };
    const outside = join(directory, "outside");
    await mkdir(outside);
    await mkdir(dirname(paths[level]), { recursive: true });
    await symlink(outside, paths[level], "dir");
    await assert.rejects(archiveBody(root, BODY));
    assert.deepEqual(await readdir(outside), []);
  });
}

test("archive refuses an existing symlink object even if its target contains matching bytes", async t => {
  const directory = await temporary(t);
  const root = storeRoot(directory);
  const hash = sha256(BODY);
  const path = join(root, "objects", hash.slice(0, 2), `${hash}.txt`);
  const outside = join(directory, "outside.txt");
  await writeFile(outside, BODY);
  await mkdir(dirname(path), { recursive: true });
  await symlink(outside, path);
  await assert.rejects(archiveBody(root, BODY));
  assert.equal(await readFile(outside, "utf8"), BODY);
});

test("candidate joins native bash text only and never follows a full-output path", async t => {
  const path = join(await temporary(t), "pi-bash-synthetic.log");
  await writeFile(path, "external bytes must not become the observation");
  const inline = `Full output: ${path}`;
  assert.deepEqual(reducibleToolResult({
    toolName: "bash", input: { command: "cargo test" }, isError: false,
    details: { fullOutputPath: path },
    content: [{ type: "text", text: "native observation" }, { type: "text", text: inline }],
  }), { command: "cargo test", body: `native observation\n${inline}` });
});

test("candidate excludes non-diagnostics, mixed content and unsupported fusion surfaces", () => {
  const event = {
    toolName: "bash", input: { command: "cargo test" }, isError: true,
    content: [{ type: "text", text: BODY }],
  };
  assert.equal(reducibleToolResult({ ...event, input: { command: "cat synthetic.log" } }), undefined);
  assert.equal(reducibleToolResult({ ...event, content: [...event.content, { type: "image", data: "synthetic" }] }), undefined);
  for (const toolName of ["eval", "edit", "write"]) {
    assert.equal(reducibleToolResult({ ...event, toolName, input: {
      command: "cargo test", then_run: { command: "cargo test" },
    } }), undefined);
  }
});
