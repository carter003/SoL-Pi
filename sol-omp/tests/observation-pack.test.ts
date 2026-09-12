import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import {
  ObservationPack, RECALL_MAX_BYTES, RECALL_MAX_LINES, runtimeRoot,
} from "../src/omp/observation-pack.ts";
import {
  countLines, createObservation, ensureStored, hash, isObservationId, isPureTextResult,
  observationPath, placeholderFor, readRecallChunk, THRESHOLD_BYTES,
} from "../src/upstream/sol-pi/observation-pack/observation.ts";
import { LARGE_TEXT, sessionContext, temporary, toolMessage, toolText } from "./helpers.ts";

const quiet = () => {};
function observation(message: AgentMessage, root: string) {
  assert.equal(isPureTextResult(message), true);
  if (!isPureTextResult(message)) throw new Error("invalid fixture");
  const result = createObservation(message, root);
  assert.ok(result);
  return result;
}
function payload(text: string) { return text.split("\n").slice(2).join("\n"); }

 test("first two projections keep full text; third becomes stable and history is untouched", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const messages = [message];
  const original = JSON.stringify(messages);
  const pack = new ObservationPack();
  const first = await pack.project(messages, root);
  const second = await pack.project(messages, root);
  const third = await pack.project(messages, root);
  const fourth = await pack.project(messages, root);
  assert.notEqual(first, messages);
  assert.equal(first[0], message);
  assert.equal(second[0], message);
  assert.notEqual(third[0], message);
  assert.equal(toolText(third[0]!), placeholderFor(observation(message, root)));
  assert.equal(toolText(fourth[0]!), toolText(third[0]!));
  assert.equal(JSON.stringify(messages), original);
  const { content: ignored, ...before } = message as any;
  const { content: changed, ...after } = third[0] as any;
  assert.deepEqual(after, before);
  assert.equal(await readFile(observation(message, root).filePath, "utf8"), LARGE_TEXT);
});

 test("eligibility: small, exactly 10 KiB, errors, mixed content and receipts stay unchanged", async t => {
  const root = join(await temporary(t), "session-a");
  const samples = [toolMessage("small"), toolMessage("x".repeat(THRESHOLD_BYTES)),
    toolMessage(LARGE_TEXT, { isError: true }), toolMessage(LARGE_TEXT, { content: [] }),
    toolMessage(LARGE_TEXT, { content: [{ type: "text", text: LARGE_TEXT }, { type: "image", data: "AA==", mimeType: "image/png" }] }),
    toolMessage(`sol_pi_evidence_receipt_v1\n${LARGE_TEXT}`),
    { role: "user", content: LARGE_TEXT, timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: LARGE_TEXT }] } as unknown as AgentMessage];
  const pack = new ObservationPack();
  for (let round = 0; round < 4; round++) {
    const projected = await pack.project(samples, root);
    for (let index = 0; index < samples.length; index++) assert.equal(projected[index], samples[index]);
  }
});

 test("10 KiB + 1 byte and multibyte text use UTF-8 bytes rather than character count", async t => {
  const root = join(await temporary(t), "session-a");
  const minimal = observation(toolMessage("x".repeat(THRESHOLD_BYTES + 1)), root);
  assert.equal(minimal.bytes, THRESHOLD_BYTES + 1);
  const chinese = observation(toolMessage("中".repeat(4000)), root);
  assert.equal(chinese.bytes, 12000);
  assert.equal(chinese.text.length, 4000);
});

 test("multiple text blocks preserve upstream newline concatenation and content identity", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage("unused", { content: [{ type: "text", text: LARGE_TEXT }, { type: "text", text: "末尾" }] });
  const item = observation(message, root);
  assert.equal(item.text, `${LARGE_TEXT}\n末尾`);
  assert.equal(item.contentHash, hash(item.text));
  assert.equal(item.id, observation(message, root).id);
  assert.notEqual(item.id, observation(toolMessage(item.text, { toolCallId: "different-call" }), root).id);
});

 test("duplicate message in one context does not consume both full sends", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const pack = new ObservationPack();
  for (let round = 0; round < 2; round++) {
    const result = await pack.project([message, message], root);
    assert.equal(result[0], message); assert.equal(result[1], message);
  }
  const result = await pack.project([message, message], root);
  assert.match(toolText(result[0]!), /large tool result replaced/);
  assert.equal(toolText(result[0]!), toolText(result[1]!));
});

 test("session A projection counts never leak to session B", async t => {
  const parent = await temporary(t);
  const pack = new ObservationPack(); const message = toolMessage();
  for (let round = 0; round < 3; round++) await pack.project([message], join(parent, "a"));
  assert.equal((await pack.project([message], join(parent, "b")))[0], message);
});

 test("restart reconstructs prior sends from following assistant messages", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const assistant = { role: "assistant", content: [{ type: "text", text: "next" }] } as unknown as AgentMessage;
  const projected = await new ObservationPack().project([message, assistant, assistant], root);
  assert.match(toolText(projected[0]!), /large tool result replaced/);
});

 test("paged recall reconstructs every original UTF-8 byte including the middle marker", async t => {
  const root = join(await temporary(t), "session-a");
  const pack = new ObservationPack(); const message = toolMessage();
  await pack.project([message], root);
  const id = observation(message, root).id;
  const pieces: string[] = []; let offset = 0; let pages = 0;
  for (;;) {
    assert.ok(pages++ < 100, "pagination must terminate");
    const result = await pack.recall(root, id, offset);
    const text = result.content[0]!.text;
    assert.ok(Buffer.byteLength(text, "utf8") <= RECALL_MAX_BYTES);
    assert.ok(countLines(text) <= RECALL_MAX_LINES);
    const chunk = payload(text);
    assert.equal(Buffer.byteLength(chunk), result.details.bytes);
    assert.equal(chunk.includes("\uFFFD"), false);
    pieces.push(chunk);
    assert.equal(result.details.nextOffset, offset + result.details.bytes);
    if (result.details.eof) break;
    assert.ok(result.details.nextOffset > offset);
    offset = result.details.nextOffset;
  }
  assert.ok(pages > 2);
  assert.equal(pieces.join(""), LARGE_TEXT);
  assert.ok(pieces.join("").includes("MIDDLE_MARKER_中间证据"));
});

 test("a long single line with emoji is paged without splitting UTF-8", async t => {
  const root = join(await temporary(t), "session-a");
  const text = "🙂中".repeat(10000); const message = toolMessage(text);
  const pack = new ObservationPack(); await pack.project([message], root);
  const id = observation(message, root).id;
  let offset = 0; let recovered = "";
  for (let page = 0; page < 20; page++) {
    const result = await pack.recall(root, id, offset);
    recovered += payload(result.content[0]!.text);
    if (result.details.eof) break;
    assert.ok(result.details.nextOffset > offset);
    offset = result.details.nextOffset;
  }
  assert.equal(recovered, text);
});

 test("same-session new instance can recall, but another session cannot use that id", async t => {
  const parent = await temporary(t); const root = join(parent, "a");
  const message = toolMessage(); await new ObservationPack().project([message], root);
  const id = observation(message, root).id;
  const restarted = new ObservationPack();
  assert.ok((await restarted.recall(root, id)).details.bytes > 0);
  await assert.rejects(restarted.recall(join(parent, "b"), id), /current session/);
});

 test("recall rejects arbitrary paths, malformed ids, unsafe offsets and mid-character offsets", async t => {
  const root = join(await temporary(t), "session-a"); const pack = new ObservationPack();
  const message = toolMessage("中🙂".repeat(5000)); await pack.project([message], root);
  const item = observation(message, root);
  for (const id of ["", "../../passwd", "/etc/passwd", "obs_abc", `${item.id}/../other`]) {
    assert.equal(isObservationId(id), false);
    await assert.rejects(pack.recall(root, id), /Invalid observation/);
  }
  for (const offset of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(pack.recall(root, item.id, offset), /safe integer/);
  }
  await assert.rejects(pack.recall(root, item.id, item.bytes + 1), /exceeds/);
  await assert.rejects(pack.recall(root, item.id, 1), /UTF-8 character/);
  const eof = await pack.recall(root, item.id, item.bytes);
  assert.equal(eof.details.eof, true); assert.equal(eof.details.bytes, 0);
  assert.equal(payload(eof.content[0]!.text), "");
});

 test("recall respects cancellation before any read", async t => {
  const root = join(await temporary(t), "session-a");
  const signal = AbortSignal.abort(new Error("fixture cancelled"));
  await assert.rejects(new ObservationPack().recall(root, "obs_" + "a".repeat(24), 0, signal), /fixture cancelled/);
});

 test("archive failure keeps original and does not consume full-send budget", async t => {
  const parent = await temporary(t); const root = join(parent, "session-a");
  await writeFile(root, "not a directory");
  const pack = new ObservationPack(); const message = toolMessage(); const warnings: string[] = [];
  for (let round = 0; round < 3; round++) assert.equal((await pack.project([message], root, text => warnings.push(text)))[0], message);
  assert.equal(warnings.length, 3);
  await unlink(root);
  assert.equal((await pack.project([message], root))[0], message);
  assert.equal((await pack.project([message], root))[0], message);
  assert.match(toolText((await pack.project([message], root))[0]!), /large tool result replaced/);
});

 test("existing object size or hash mismatch fails open without overwriting data", async t => {
  const root = join(await temporary(t), "session-a"); const message = toolMessage();
  const item = observation(message, root); const pack = new ObservationPack();
  await pack.project([message], root); await pack.project([message], root);
  for (const corrupt of ["short", "x".repeat(item.bytes)]) {
    await writeFile(item.filePath, corrupt);
    assert.equal((await pack.project([message], root, quiet))[0], message);
    assert.equal(await readFile(item.filePath, "utf8"), corrupt);
  }
});

 test("deleted archive is restored from intact history before the next placeholder", async t => {
  const root = join(await temporary(t), "session-a"); const message = toolMessage(); const pack = new ObservationPack();
  await pack.project([message], root); await pack.project([message], root);
  const file = observation(message, root).filePath; await unlink(file);
  assert.match(toolText((await pack.project([message], root))[0]!), /large tool result replaced/);
  assert.equal(await readFile(file, "utf8"), LARGE_TEXT);
});

 test("archive file symlink is never followed for writing or recall", async t => {
  const parent = await temporary(t); const root = join(parent, "session-a");
  const message = toolMessage(); const item = observation(message, root);
  await mkdir(dirname(item.filePath), { recursive: true });
  const victim = join(parent, "unrelated.txt"); await writeFile(victim, LARGE_TEXT);
  await symlink(victim, item.filePath);
  const pack = new ObservationPack();
  for (let round = 0; round < 3; round++) assert.equal((await pack.project([message], root, quiet))[0], message);
  await assert.rejects(pack.recall(root, item.id));
  assert.equal(await readFile(victim, "utf8"), LARGE_TEXT);
});

 test("archive directory and session-root symlinks are refused", async t => {
  for (const level of ["root", "observation-pack", "objects"]) {
    const parent = await temporary(t); const root = join(parent, "session-a");
    const outside = join(parent, "outside"); await mkdir(outside);
    const redirected = level === "root" ? root : level === "observation-pack" ? join(root, level) : join(root, "observation-pack", level);
    await mkdir(dirname(redirected), { recursive: true }); await symlink(outside, redirected);
    const message = toolMessage(); const pack = new ObservationPack();
    for (let round = 0; round < 3; round++) assert.equal((await pack.project([message], root, quiet))[0], message);
    await assert.rejects(pack.recall(root, observation(message, root).id), /symbolic link/);
  }
});

 test("new archive file and objects directory use private permissions on Linux", async t => {
  const root = join(await temporary(t), "session-a"); const item = observation(toolMessage(), root);
  await ensureStored(item);
  assert.equal((await stat(item.filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(item.filePath))).mode & 0o777, 0o700);
});

 test("runtime root follows the current session and refuses unsafe paths and ids", async t => {
  const directory = await temporary(t);
  assert.equal(runtimeRoot(sessionContext(directory, "a")), join(directory, "sol-omp", "a"));
  assert.equal(runtimeRoot(sessionContext(directory, "b")), join(directory, "sol-omp", "b"));
  for (const id of ["", ".", "..", "../other", "a/b", "a\\b"]) assert.throws(() => runtimeRoot(sessionContext(directory, id)), /safe/);
  assert.throws(() => runtimeRoot(sessionContext("relative", "a")), /absolute/);
});

 test("low-level pager validates its limits and handles line boundaries", async t => {
  const directory = await temporary(t); const file = join(directory, "page.txt");
  await writeFile(file, "中\n文\n🙂\n");
  const result = await readRecallChunk(file, 0, { maxBytes: 100, maxLines: 1 });
  assert.equal(result.text, "中\n"); assert.equal(result.nextOffset, 4);
  for (const limits of [{ maxBytes: 3, maxLines: 1 }, { maxBytes: 100, maxLines: 0 }]) {
    await assert.rejects(readRecallChunk(file, 0, limits), /limits/);
  }
});
