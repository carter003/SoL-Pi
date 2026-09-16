import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ContextEvent, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import {
  isCompressibleObservation, ObservationPack, RECALL_MAX_BYTES, RECALL_MAX_LINES, registerObservationPack, runtimeRoot,
} from "../src/omp/observation-pack.ts";
import { candidateArtifactDirectories, resolveArtifactContent } from "../src/omp/artifact-source.ts";
import {
  countLines, createObservation, ensureStored, hash, isObservationId, isPureTextResult,
  observationPath, placeholderFor, readRecallChunk, THRESHOLD_BYTES,
} from "../src/upstream/sol-pi/observation-pack/observation.ts";
import { fakeApi, LARGE_TEXT, sessionContext, temporary, toolMessage, toolText } from "./helpers.ts";

const quiet = () => {};
function observation(message: AgentMessage, root: string) {
  assert.equal(isPureTextResult(message), true);
  if (!isPureTextResult(message)) throw new Error("invalid fixture");
  const result = createObservation(message, root);
  assert.ok(result);
  return result;
}
function payload(text: string) { return text.split("\n").slice(2).join("\n"); }

 test("first projection replaces large text and remains stable without mutating history", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const messages = [message];
  const original = JSON.stringify(messages);
  const pack = new ObservationPack();
  const first = await pack.project(messages, root);
  const second = await pack.project(messages, root);
  const third = await pack.project(messages, root);
  assert.notEqual(first, messages);
  assert.notEqual(first[0], message);
  assert.equal(toolText(first[0]!), placeholderFor(observation(message, root)));
  assert.equal(toolText(second[0]!), toolText(first[0]!));
  assert.equal(toolText(third[0]!), toolText(first[0]!));
  assert.equal(JSON.stringify(messages), original);
  const { content: ignored, ...before } = message as any;
  const { content: changed, ...after } = first[0] as any;
  assert.deepEqual(after, before);
  assert.equal(await readFile(observation(message, root).filePath, "utf8"), LARGE_TEXT);
});

 test("small, exactly 10 KiB, mixed content and receipts stay unchanged; large errors pack", async t => {
  const root = join(await temporary(t), "session-a");
  const error = toolMessage(LARGE_TEXT, { isError: true, toolCallId: "call-error" });
  const samples = [toolMessage("small"), toolMessage("x".repeat(THRESHOLD_BYTES)), toolMessage(LARGE_TEXT, { content: [] }),
    toolMessage(LARGE_TEXT, { content: [{ type: "text", text: LARGE_TEXT }, { type: "image", data: "AA==", mimeType: "image/png" }] }),
    toolMessage(`sol_pi_evidence_receipt_v1\n${LARGE_TEXT}`),
    { role: "user", content: LARGE_TEXT, timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: LARGE_TEXT }] } as unknown as AgentMessage];
  const pack = new ObservationPack();
  for (let round = 0; round < 4; round++) {
    const projected = await pack.project(samples, root);
    for (let index = 0; index < samples.length; index++) assert.equal(projected[index], samples[index]);
  }
  const packedError = await pack.project([error], root);
  assert.match(toolText(packedError[0]!), /replaced before its first provider request/);
  assert.ok(packedError[0]?.role === "toolResult" && packedError[0].isError);
  assert.equal(await readFile(observation(error, root).filePath, "utf8"), LARGE_TEXT);
});

test("all large text tools pack immediately except bounded observation recall", async t => {
  const root = join(await temporary(t), "session-a");
  const pack = new ObservationPack();
  for (const toolName of ["read", "grep", "glob", "edit", "write", "eval", "bash"]) {
    const message = toolMessage(LARGE_TEXT, { toolName, toolCallId: `call-${toolName}` });
    assert.match(toolText((await pack.project([message], root))[0]!), /replaced before its first provider request/);
    assert.equal(isCompressibleObservation(toolName, {}), true);
  }
  const recall = toolMessage(LARGE_TEXT, { toolName: "obs_recall", toolCallId: "call-recall" });
  assert.equal((await pack.project([recall], root))[0], recall);
  assert.equal(isCompressibleObservation("obs_recall", {}), false);
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

 test("duplicate messages receive the same immediate placeholder", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const pack = new ObservationPack();
  const result = await pack.project([message, message], root);
  assert.match(toolText(result[0]!), /large tool result replaced/);
  assert.equal(toolText(result[0]!), toolText(result[1]!));
});

 test("session archives remain isolated", async t => {
  const parent = await temporary(t);
  const pack = new ObservationPack(); const message = toolMessage();
  const a = await pack.project([message], join(parent, "a"));
  const b = await pack.project([message], join(parent, "b"));
  assert.match(toolText(a[0]!), /large tool result replaced/);
  assert.match(toolText(b[0]!), /large tool result replaced/);
  assert.notEqual(observation(message, join(parent, "a")).filePath, observation(message, join(parent, "b")).filePath);
});

 test("restart immediately projects archived history", async t => {
  const root = join(await temporary(t), "session-a");
  const message = toolMessage();
  const assistant = { role: "assistant", content: [{ type: "text", text: "next" }] } as unknown as AgentMessage;
  const projected = await new ObservationPack().project([message, assistant, assistant], root);
  assert.match(toolText(projected[0]!), /large tool result replaced/);
});

test("truncated host output is recovered from its OMP artifact before archiving", async t => {
  const directory = await temporary(t);
  const artifactPath = join(directory, "7.bash-original.log");
  await writeFile(artifactPath, LARGE_TEXT);
  const ctx = sessionContext(directory, "artifact-recovery", {
    getArtifactPath: async (id: string) => id === "7" ? artifactPath : null,
    getArtifactsDir: () => directory,
  });
  const root = runtimeRoot(ctx);
  const preview = "0000 head\n[…1400ln elided…]\n1599 tail\n[raw output: artifact://7]";
  const message = toolMessage(preview, { toolName: "bash", toolCallId: "call-artifact", details: {
    meta: { truncation: { artifactId: "7", direction: "middle" } },
  } });
  const source = toolMessage(LARGE_TEXT, { toolName: "bash", toolCallId: "call-artifact", details: message.role === "toolResult" ? message.details : undefined });
  const projected = await new ObservationPack().project([message], root, quiet, undefined, ctx);
  assert.match(toolText(projected[0]!), new RegExp(`id: ${observation(source, root).id}`));
  assert.equal(await readFile(observation(source, root).filePath, "utf8"), LARGE_TEXT);
  assert.equal(toolText(message), preview);
});

test("unavailable truncated artifact fails open and never archives the preview", async t => {
  const directory = await temporary(t);
  const ctx = sessionContext(directory, "artifact-missing", {
    getArtifactPath: async () => null,
    getArtifactsDir: () => directory,
  });
  const root = runtimeRoot(ctx);
  const preview = `${"head\n".repeat(3000)}[…80ln elided…]\n[raw output: artifact://99]`;
  const message = toolMessage(preview, { toolName: "bash", details: {
    meta: { truncation: { artifactId: "99", direction: "middle" } },
  } });
  const warnings: string[] = [];
  const projected = await new ObservationPack().project([message], root, warning => warnings.push(warning), undefined, ctx);
  assert.equal(projected[0], message);
  assert.equal(warnings.length, 1);
  await assert.rejects(readFile(observation(message, root).filePath, "utf8"));
});

test("host pagination without an artifact is retained without a packing warning", async t => {
  const root = join(await temporary(t), "pagination-without-artifact");
  const previews = [
    toolMessage(`${"line\n".repeat(3000)}[Showing lines 1-3000 of 6000]`, { toolName: "read" }),
    toolMessage(`${"head\n".repeat(3000)}[…80ln elided…]`, { toolName: "eval", details: {
      meta: { truncation: { direction: "middle", totalLines: 3080 } },
    } }),
  ];
  const warnings: string[] = [];
  const projected = await new ObservationPack().project(previews, root, warning => warnings.push(warning));
  assert.deepEqual(projected, previews);
  assert.equal(warnings.length, 0);
  for (const preview of previews) {
    await assert.rejects(readFile(observation(preview, root).filePath, "utf8"));
  }
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

 test("archive failure keeps original and first successful retry replaces it", async t => {
  const parent = await temporary(t); const root = join(parent, "session-a");
  await writeFile(root, "not a directory");
  const pack = new ObservationPack(); const message = toolMessage(); const warnings: string[] = [];
  for (let round = 0; round < 3; round++) assert.equal((await pack.project([message], root, text => warnings.push(text)))[0], message);
  assert.equal(warnings.length, 3);
  await unlink(root);
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

test("resolveArtifactContent recovers from subagent/sessionFile candidate directory", async t => {
  const directory = await temporary(t);
  const sessionFile = join(directory, "nested", "session-sub.jsonl");
  const artifactsDir = join(directory, "nested", "session-sub");
  await mkdir(artifactsDir, { recursive: true });
  const artifactPath = join(artifactsDir, "16.bash-original.log");
  await writeFile(artifactPath, LARGE_TEXT);

  const ctx = sessionContext(directory, "sub-session", {
    getArtifactPath: async () => null,
    getArtifactsDir: () => join(directory, "parent-artifacts"),
    getSessionFile: () => sessionFile,
  });

  const content = await resolveArtifactContent("16", ctx);
  assert.equal(content, LARGE_TEXT);
});

test("context hook uses UI notify for packing warnings and deduplicates repeated alerts", async t => {
  const fake = await fakeApi(t);
  registerObservationPack(fake.api, true);
  const handler = fake.handlers.get("context");
  assert.ok(handler);

  const notifications: Array<{ message: string; level: string }> = [];
  const fakeCtx = {
    ...sessionContext(fake.root, "ui-session", {
      getArtifactPath: async () => null,
      getArtifactsDir: () => fake.root,
    }),
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;

  const preview = `${"head\n".repeat(3000)}[…80ln elided…]\n[raw output: artifact://16]`;
  const message = toolMessage(preview, { toolName: "bash", details: {
    meta: { truncation: { artifactId: "16", direction: "middle" } },
  } });
  const event = { type: "context", messages: [message] };

  const result1 = await handler(event, fakeCtx);
  assert.equal(result1.messages[0], message);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message, /artifact 16 is unavailable or incomplete/);

  const result2 = await handler(event, fakeCtx);
  assert.equal(result2.messages[0], message);
  assert.equal(notifications.length, 1);
});
