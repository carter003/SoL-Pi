import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  installCodexUser,
  mergeGlobalAgents,
  mergePostToolUseHook,
  upsertTopLevelTokenLimit,
} from "../src/codex/user-install.ts";
import { temporary } from "./helpers.ts";

test("user installer preserves config tables and replaces only the top-level output budget", () => {
  const source = 'model = "gpt"\ntool_output_token_limit = 1000\n\n[profile.dev]\ntool_output_token_limit = 99\n';
  const updated = upsertTopLevelTokenLimit(source);
  assert.match(updated, /^model = "gpt"\ntool_output_token_limit = 12000/mu);
  assert.match(updated, /\[profile\.dev\]\ntool_output_token_limit = 99/u);
});

test("user installer merges hooks and global instructions idempotently", () => {
  const existing = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }] } });
  const once = mergePostToolUseHook(existing, "bun sol codex post-tool-use");
  const twice = mergePostToolUseHook(once, "bun sol codex post-tool-use");
  assert.deepEqual(JSON.parse(twice), JSON.parse(once));
  assert.equal((JSON.parse(once).hooks.SessionStart as unknown[]).length, 1);
  const agents = mergeGlobalAgents("# Existing\n");
  assert.equal(mergeGlobalAgents(agents), agents);
  assert.match(agents, /max_output_tokens` to `12000`/u);
});

test("user installer writes a complete isolated Codex home", async t => {
  const codexHome = await temporary(t);
  const result = await installCodexUser(codexHome);
  assert.equal(result.codexHome, codexHome);
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /^tool_output_token_limit = 12000$/mu);
  const hooks = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.PostToolUse[0].matcher, "^Bash$");
  assert.match(hooks.hooks.PostToolUse[0].hooks[0].command, /src\/codex\/cli\.ts.*post-tool-use/u);
  assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /SoL Observation Pack/u);
});
