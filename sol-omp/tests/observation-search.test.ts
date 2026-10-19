import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import solOmp from "../src/index.ts";
import { isCompressibleObservation, ObservationPack, RECALL_MAX_BYTES, runtimeRoot } from "../src/omp/observation-pack.ts";
import { createObservation, observationPath } from "../src/upstream/sol-pi/observation-pack/observation.ts";
import { fakeApi, sessionContext, temporary, toolMessage } from "./helpers.ts";

async function stored(directory: string, body: string) {
  const root = runtimeRoot(sessionContext(directory));
  const message = toolMessage(body) as Parameters<typeof createObservation>[0];
  const pack = new ObservationPack();
  await pack.project([message], root);
  return { root, pack, id: createObservation(message, root)!.id };
}

test("search finds an exact Unicode match across a scan boundary and recall restores the source", async t => {
  const prefix = "x".repeat(65534);
  const query = "证据🙂[literal.*]";
  const body = `${prefix}${query}\n${"tail\n".repeat(900)}`;
  const { root, pack, id } = await stored(await temporary(t), body);
  const result = await pack.search(root, id, query);
  assert.equal(result.details.matches.length, 1);
  const match = result.details.matches[0]!;
  assert.equal(match.offset, Buffer.byteLength(prefix));
  assert.ok(match.text.includes(query));
  const recalled = await pack.recall(root, id, match.excerptOffset);
  assert.ok(recalled.content[0]!.text.includes(query));
  assert.equal(result.details.eof, true);
  assert.equal((await pack.search(root, id, "not present")).details.matches.length, 0);
  assert.equal(isCompressibleObservation("obs_search", {}), false);
});

test("search paginates repeated matches without loss or duplication and bounds hostile excerpts", async t => {
  const body = ("\u0001\n".repeat(300) + "needle🙂\n").repeat(31);
  const { root, pack, id } = await stored(await temporary(t), body);
  let offset = 0;
  const hits: number[] = [];
  for (;;) {
    const result = await pack.search(root, id, "needle🙂", offset);
    assert.ok(result.details.matches.length <= 10);
    assert.ok(Buffer.byteLength(result.content[0]!.text) <= RECALL_MAX_BYTES);
    assert.ok(result.content[0]!.text.split("\n").length <= 12);
    for (const match of result.details.matches) {
      hits.push(match.offset);
      assert.equal(match.text.includes("\ufffd"), false);
    }
    if (result.details.eof) break;
    assert.ok(result.details.nextOffset > offset);
    offset = result.details.nextOffset;
  }
  assert.equal(hits.length, 31);
  assert.equal(new Set(hits).size, hits.length);
});

test("search validates offsets and queries, respects cancellation and session isolation, and refuses symlinks", async t => {
  const directory = await temporary(t);
  const { root, pack, id } = await stored(directory, "text evidence\n".repeat(2000));
  for (const query of ["", "\0", "中".repeat(86)]) await assert.rejects(pack.search(root, id, query), /query/);
  for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 999999]) await assert.rejects(pack.search(root, id, "text", offset), /offset/);
  await assert.rejects(pack.search(root, "../../file", "text"), /Invalid observation id/);
  await assert.rejects(pack.search(runtimeRoot(sessionContext(directory, "other")), id, "text"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pack.search(root, id, "text", 0, controller.signal), /abort/iu);
  const otherId = "obs_" + "f".repeat(24);
  const target = join(directory, "outside.txt"); await writeFile(target, "outside");
  await symlink(target, observationPath(root, otherId));
  await assert.rejects(pack.search(root, otherId, "outside"));
});

test("disabled packing keeps the registered read-only search available for existing archives", async t => {
  const fake = await fakeApi(t);
  const { id } = await stored(fake.root, "middle evidence\n".repeat(1200));
  await solOmp(fake.api);
  const search = fake.tools.find(tool => tool.name === "obs_search")!;
  assert.equal(search.approval, "read");
  assert.equal(search.loadMode, "essential");
  const result = await search.execute("search", { id, query: "middle evidence" }, undefined, undefined, sessionContext(fake.root));
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /matches=10/);
  assert.equal(fake.handlers.has("context"), false);
  assert.equal(fake.execCalls(), 0);
});
