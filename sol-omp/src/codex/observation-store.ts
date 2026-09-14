import { randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { countLines, hash, readRecallChunk } from "../upstream/sol-pi/observation-pack/observation.ts";

const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface CodexObservationMeta {
  readonly version: 1;
  readonly id: string;
  readonly host: "codex";
  readonly capture: "codex-post-tool-use";
  readonly captureComplete: "unknown";
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly toolUseId: string;
  readonly tool: string;
  readonly command: string;
  readonly timestamp: string;
  readonly exitCode: number | null;
  readonly exitCodeAvailable: boolean;
  readonly rawBytes: number;
  readonly rawChars: number;
  readonly rawLines: number;
  readonly rawSha256: string;
  readonly reducedBytes: number | null;
}

export interface StoredCodexObservation {
  readonly directory: string;
  readonly meta: CodexObservationMeta;
  readonly rawPath: string;
  readonly reducedPath: string;
}

export function defaultObservationBaseRoot(): string {
  const configured = process.env.SOL_CODEX_OBSERVATIONS_ROOT;
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".sol", "observations");
}

export function projectRootForCwd(cwd: string): string {
  const absolute = resolve(cwd);
  let current: string;
  try {
    current = realpathSync.native(absolute);
  } catch {
    current = absolute;
  }
  const canonicalCwd = current;
  const filesystemRoot = parse(current).root;
  for (;;) {
    try {
      const marker = lstatSync(join(current, ".git"));
      if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    } catch {
      // Continue towards the filesystem root when this directory is not a Git worktree.
    }
    if (current === filesystemRoot) return canonicalCwd;
    current = dirname(current);
  }
}

export function projectObservationRoot(
  cwd = process.cwd(),
  baseRoot = defaultObservationBaseRoot(),
): string {
  const projectKey = hash(projectRootForCwd(cwd));
  return join(baseRoot, "projects", projectKey);
}

export function defaultObservationRoot(cwd = process.cwd()): string {
  return projectObservationRoot(cwd);
}

export function isCodexObservationId(value: string): boolean {
  return OBSERVATION_ID_PATTERN.test(value);
}

async function ensureDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Observation root must be absolute");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Observation root is not a regular directory");
}

async function writeExclusive(path: string, value: string): Promise<void> {
  const handle = await open(path, CREATE_FLAGS, 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export async function storeCodexObservation(
  input: Omit<CodexObservationMeta, "version" | "id" | "host" | "capture" | "captureComplete" |
    "timestamp" | "rawBytes" | "rawChars" | "rawLines" | "rawSha256" | "reducedBytes"> & { readonly raw: string },
  root = defaultObservationRoot(),
  now = new Date(),
): Promise<StoredCodexObservation> {
  await ensureDirectory(root);
  let id = "";
  let directory = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    id = `obs_${randomBytes(12).toString("hex")}`;
    directory = join(root, id);
    try {
      await mkdir(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" || attempt === 7) throw error;
    }
  }
  const rawPath = join(directory, "raw.txt");
  const reducedPath = join(directory, "reduced.txt");
  const meta: CodexObservationMeta = Object.freeze({
    version: 1,
    id,
    host: "codex",
    capture: "codex-post-tool-use",
    captureComplete: "unknown",
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolUseId: input.toolUseId,
    tool: input.tool,
    command: input.command,
    timestamp: now.toISOString(),
    exitCode: input.exitCode,
    exitCodeAvailable: input.exitCodeAvailable,
    rawBytes: Buffer.byteLength(input.raw, "utf8"),
    rawChars: input.raw.length,
    rawLines: countLines(input.raw),
    rawSha256: hash(input.raw),
    reducedBytes: null,
  });
  await writeExclusive(rawPath, input.raw);
  await writeExclusive(join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { directory, meta, rawPath, reducedPath };
}

export async function storeReducedObservation(
  record: StoredCodexObservation,
  reduced: string,
  status: { readonly exitCode: number | null; readonly exitCodeAvailable: boolean },
): Promise<CodexObservationMeta> {
  await writeExclusive(record.reducedPath, reduced);
  const meta = Object.freeze({
    ...record.meta,
    ...status,
    reducedBytes: Buffer.byteLength(reduced, "utf8"),
  });
  await replaceJson(join(record.directory, "meta.json"), meta);
  return meta;
}

export function observationDirectory(root: string, id: string): string {
  if (!isCodexObservationId(id)) throw new Error("Invalid observation id");
  return join(root, id);
}

export async function readObservationMeta(root: string, id: string): Promise<CodexObservationMeta> {
  const path = join(observationDirectory(root, id), "meta.json");
  const handle = await open(path, READ_FLAGS);
  try {
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { id?: unknown }).id !== id) {
      throw new Error("Observation metadata does not match its id");
    }
    return parsed as CodexObservationMeta;
  } finally {
    await handle.close();
  }
}

export async function readObservationChunk(root: string, id: string, offset: number, maxBytes: number) {
  return readRecallChunk(join(observationDirectory(root, id), "raw.txt"), offset, { maxBytes, maxLines: 400 });
}

export async function readWholeObservation(root: string, id: string): Promise<string> {
  const path = join(observationDirectory(root, id), "raw.txt");
  const handle = await open(path, READ_FLAGS);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function searchObservation(
  root: string,
  id: string,
  query: string,
  contextLines = 3,
  maxMatches = 20,
  maxBytes = 16 * 1024,
): Promise<string> {
  if (!query) throw new Error("Search query must not be empty");
  if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 20) throw new Error("Invalid context-lines");
  const raw = await readWholeObservation(root, id);
  const lines = raw.split("\n");
  const selected = new Set<number>();
  let matches = 0;
  for (let index = 0; index < lines.length && matches < maxMatches; index++) {
    if (!lines[index]!.includes(query)) continue;
    matches++;
    for (let cursor = Math.max(0, index - contextLines); cursor <= Math.min(lines.length - 1, index + contextLines); cursor++) {
      selected.add(cursor);
    }
  }
  const output: string[] = [`observation_id=${id}`, `query=${JSON.stringify(query)}`, `matches=${matches}`];
  let previous = -2;
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (index > previous + 1) output.push("--");
    output.push(`${index + 1}: ${lines[index]}`);
    previous = index;
    if (Buffer.byteLength(output.join("\n"), "utf8") > maxBytes) {
      output.push("[search output truncated; narrow the query or context]");
      break;
    }
  }
  return output.join("\n");
}
