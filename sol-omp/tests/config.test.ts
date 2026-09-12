import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";
import { requireSupportedFeatures } from "../src/omp/action-fusion.ts";
import { temporary } from "./helpers.ts";

 test("configuration defaults every absent feature to false and freezes the result", () => {
  assert.deepEqual(parseConfig('{"version":1}'), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig('{"version":1,"observationPack":true}'), {
    version: 1, observationPack: true, actionFusion: false,
  });
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(parseConfig('{"version":1}')), true);
});

 test("configuration rejects malformed JSON, wrong version, unknown keys and non-booleans", () => {
  const invalid = ["", "{", "null", "[]", "1", '"value"', "{}", '{"version":2}',
    '{"version":"1"}', '{"version":1,"onlineContextCompact":true}',
    '{"version":1,"evidencePreservingReducer":false}', '{"version":1,"observationPack":null}',
    '{"version":1,"actionFusion":0}', '{"version":1,"observationPack":"true"}',
    '{"version":1,"__proto__":{}}'];
  for (const text of invalid) assert.throws(() => parseConfig(text), Error, text);
});

 test("configuration errors never echo unknown values or malformed file contents", () => {
  const marker = "TEST_ONLY_SENSITIVE_MARKER";
  for (const input of [`{${marker}`, JSON.stringify({ version: 1, token: marker })]) {
    try { parseConfig(input); assert.fail("should reject"); }
    catch (error) { assert.ok(error instanceof Error); assert.equal(error.message.includes(marker), false); }
  }
});

 test("missing user config uses defaults without creating any file", async t => {
  const directory = await temporary(t);
  const result = await loadConfig(directory);
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.path, join(directory, "sol-omp.json"));
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.deepEqual(await readdir(directory), []);
});

 test("only the supplied profile directory is read; project settings are ignored", async t => {
  const directory = await temporary(t);
  const agent = join(directory, "profiles", "work", "agent");
  await mkdir(agent, { recursive: true });
  await writeFile(join(directory, "sol-omp.json"), '{"version":1,"actionFusion":true}');
  assert.deepEqual((await loadConfig(agent)).config, DEFAULT_CONFIG);
  const text = '{"version":1,"observationPack":true}';
  await writeFile(join(agent, "sol-omp.json"), text);
  assert.equal((await loadConfig(agent)).config.observationPack, true);
  assert.equal(await readFile(join(agent, "sol-omp.json"), "utf8"), text);
});

 test("missing or relative agent directory is rejected rather than guessed", async () => {
  for (const directory of ["", ".", "relative/agent"]) await assert.rejects(loadConfig(directory), /absolute/);
});

 test("existing malformed or unreadable config is not treated as absent", async t => {
  const directory = await temporary(t);
  const file = join(directory, "sol-omp.json");
  await writeFile(file, '{"version":1,"observationPack":"yes"}');
  await assert.rejects(loadConfig(directory), /boolean/);
  const second = await temporary(t);
  await mkdir(join(second, "sol-omp.json"));
  await assert.rejects(loadConfig(second), /Cannot read/);
});

 test("Action Fusion is an explicit blocked feature, not a silently ignored switch", () => {
  requireSupportedFeatures(DEFAULT_CONFIG);
  assert.throws(() => requireSupportedFeatures(parseConfig('{"version":1,"actionFusion":true}')), /same native tool/);
});
