import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const AGENTS_START = "<!-- sol-codex-observation-pack:start -->";
const AGENTS_END = "<!-- sol-codex-observation-pack:end -->";

interface HookHandler {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly [key: string]: unknown;
}

interface HookEntry {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

interface HooksFile {
  readonly description?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

export interface CodexUserInstallResult {
  readonly codexHome: string;
  readonly configPath: string;
  readonly hooksPath: string;
  readonly agentsPath: string;
  readonly hookCommand: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.sol-${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporary, CREATE_FLAGS, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function upsertTopLevelTokenLimit(config: string, value = 12_000): string {
  const lines = config.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/u.test(line));
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const matches: number[] = [];
  for (let index = 0; index < topLevelEnd; index++) {
    if (/^\s*tool_output_token_limit\s*=/u.test(lines[index] ?? "")) matches.push(index);
  }
  if (matches.length > 1) throw new Error("config.toml has duplicate top-level tool_output_token_limit keys");
  if (matches.length === 1) {
    lines[matches[0]!] = `tool_output_token_limit = ${value}`;
  } else {
    lines.splice(topLevelEnd, 0, `tool_output_token_limit = ${value}`, "");
  }
  return lines.join("\n").replace(/\n*$/u, "\n");
}

export function mergePostToolUseHook(source: string | undefined, command: string): string {
  const parsed = source === undefined ? {} : JSON.parse(source) as HooksFile;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hooks.json must contain an object");
  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("hooks.json hooks must contain an object");
  const hookRecord = hooks as Record<string, unknown>;
  const existing = hookRecord.PostToolUse === undefined ? [] : hookRecord.PostToolUse;
  if (!Array.isArray(existing)) throw new Error("hooks.json PostToolUse must contain an array");
  const alreadyPresent = existing.some(value => {
    const entry = value as HookEntry;
    return Array.isArray(entry?.hooks) && entry.hooks.some(handler => (handler as HookHandler)?.command === command);
  });
  const postToolUse = alreadyPresent ? existing : [
    ...existing,
    {
      matcher: "^Bash$",
      hooks: [{
        type: "command",
        command,
        timeout: 30,
        statusMessage: "Reducing large tool output with SoL",
      }],
    },
  ];
  return `${JSON.stringify({
    ...parsed,
    description: parsed.description ?? "User-level Codex hooks",
    hooks: { ...hookRecord, PostToolUse: postToolUse },
  }, null, 2)}\n`;
}

export function mergeGlobalAgents(source: string | undefined): string {
  const current = source ?? "";
  if (current.includes(AGENTS_START) || current.includes(AGENTS_END)) {
    if (current.includes(AGENTS_START) && current.includes(AGENTS_END)) return current;
    throw new Error("AGENTS.md contains an incomplete SoL managed block");
  }
  const block = [
    AGENTS_START,
    "## SoL Observation Pack for Codex",
    "",
    "When calling `exec_command` or `write_stdin`, always set `max_output_tokens` to `12000`.",
    "Do not lower this value. A user-level synchronous PostToolUse hook archives and reduces large output.",
    AGENTS_END,
    "",
  ].join("\n");
  return current.trimEnd() ? `${current.trimEnd()}\n\n${block}` : block;
}

export async function installCodexUser(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")):
Promise<CodexUserInstallResult> {
  if (!isAbsolute(codexHome)) throw new Error("CODEX_HOME must be absolute");
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} codex post-tool-use`;
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const agentsPath = join(codexHome, "AGENTS.md");
  const [config, hooks, agents] = await Promise.all([
    readOptional(configPath),
    readOptional(hooksPath),
    readOptional(agentsPath),
  ]);
  await atomicWrite(configPath, upsertTopLevelTokenLimit(config ?? ""));
  await atomicWrite(hooksPath, mergePostToolUseHook(hooks, hookCommand));
  await atomicWrite(agentsPath, mergeGlobalAgents(agents));
  return { codexHome, configPath, hooksPath, agentsPath, hookCommand };
}
