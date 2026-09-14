import { reduceCodexObservation } from "./evidence-reducer.ts";
import {
  defaultObservationRoot,
  storeCodexObservation,
  storeReducedObservation,
} from "./observation-store.ts";
import { isCompressibleDiagnosticCommand } from "../output-density.ts";

export const CODEX_OBSERVATION_THRESHOLD_BYTES = 4 * 1024;

export interface PostToolUseInput {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly turn_id?: unknown;
  readonly tool_name?: unknown;
  readonly tool_use_id?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly cwd?: unknown;
}

export interface PostToolUseReplacement {
  readonly decision: "block";
  readonly reason: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function extractToolResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  if (!object) return undefined;
  for (const key of ["output", "text", "content"]) {
    const candidate = object[key];
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate) && candidate.every(item => record(item)?.type === "text" && typeof record(item)?.text === "string")) {
      return candidate.map(item => String(record(item)?.text)).join("\n");
    }
  }
  return JSON.stringify(value);
}

export function extractCommand(value: unknown): string {
  const object = record(value);
  if (!object) return "";
  for (const key of ["command", "cmd"]) {
    const command = object[key];
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every(item => typeof item === "string")) return command.join(" ");
  }
  return "";
}

export function isRecallCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:\S*\/)?sol(?:\s+|[^\n]*\s+)observation\s+(?:read|search|meta)\b/u.test(command)
    || /src\/codex\/cli\.ts[^\n]*\sobservation\s+(?:read|search|meta)\b/u.test(command);
}

export { isCompressibleDiagnosticCommand } from "../output-density.ts";

export function extractStructuredExitCode(value: unknown): number | null {
  const object = record(value);
  if (!object) return null;
  const details = record(object.details);
  for (const candidate of [object.exitCode, object.exit_code, details?.exitCode, details?.exit_code]) {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return candidate;
  }
  return null;
}

export async function handlePostToolUse(
  input: PostToolUseInput,
  options: { readonly root?: string; readonly thresholdBytes?: number; readonly now?: Date } = {},
): Promise<PostToolUseReplacement | undefined> {
  if (input.hook_event_name !== undefined && input.hook_event_name !== "PostToolUse") return undefined;
  const raw = extractToolResponse(input.tool_response);
  if (raw === undefined) return undefined;
  const threshold = options.thresholdBytes ?? CODEX_OBSERVATION_THRESHOLD_BYTES;
  if (Buffer.byteLength(raw, "utf8") < threshold) return undefined;
  const command = extractCommand(input.tool_input);
  if (isRecallCommand(command)) return undefined;
  if (!isCompressibleDiagnosticCommand(command)) return undefined;
  const initialExitCode = extractStructuredExitCode(input.tool_response);
  const stored = await storeCodexObservation({
    sessionId: typeof input.session_id === "string" ? input.session_id : "unknown",
    turnId: typeof input.turn_id === "string" ? input.turn_id : null,
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : "unknown",
    tool: typeof input.tool_name === "string" ? input.tool_name : "unknown",
    command,
    exitCode: initialExitCode,
    exitCodeAvailable: initialExitCode !== null,
    raw,
  }, options.root ?? defaultObservationRoot(typeof input.cwd === "string" ? input.cwd : process.cwd()), options.now);
  const reduced = reduceCodexObservation(stored.meta, raw);
  const receipt = reduced.receipt;
  if (Buffer.byteLength(receipt, "utf8") >= stored.meta.rawBytes) return undefined;
  await storeReducedObservation(stored, receipt, {
    exitCode: reduced.exitCode,
    exitCodeAvailable: reduced.exitCodeAvailable,
  });
  // Codex 0.154.0 documents continue:false replacement, but the real CLI path
  // tested on 2026-09-14 only applied decision:block feedback before history.
  return { decision: "block", reason: receipt };
}
