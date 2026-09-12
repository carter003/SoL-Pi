import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface SolOmpConfig {
  readonly version: 1;
  readonly observationPack: boolean;
  readonly actionFusion: boolean;
  readonly evidencePreservingReducer: boolean;
  readonly evidencePreservingReducerProvider?: string;
  readonly evidencePreservingReducerModel?: string;
  readonly evidencePreservingReducerTimeoutMs: number;
}

export const DEFAULT_CONFIG: SolOmpConfig = Object.freeze({
  version: 1,
  observationPack: false,
  actionFusion: false,
  evidencePreservingReducer: false,
  evidencePreservingReducerTimeoutMs: 90000,
});

const ALLOWED_KEYS = new Set(["version", "observationPack", "actionFusion", "evidencePreservingReducer",
  "evidencePreservingReducerProvider", "evidencePreservingReducerModel", "evidencePreservingReducerTimeoutMs"]);

export function parseConfig(text: string): SolOmpConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Do not include the file contents (possibly containing secrets) in errors.
    throw new Error("sol-omp.json must contain valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("sol-omp.json must contain a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !ALLOWED_KEYS.has(key))) {
    throw new Error("sol-omp.json contains an unsupported key");
  }
  if (input.version !== 1) throw new Error("sol-omp.json requires version: 1");
  for (const key of ["observationPack", "actionFusion", "evidencePreservingReducer"] as const) {
    if (Object.hasOwn(input, key) && typeof input[key] !== "boolean") {
      throw new Error(`sol-omp.json: ${key} must be a boolean`);
    }
  }
  for (const key of ["evidencePreservingReducerProvider", "evidencePreservingReducerModel"] as const) {
    if ((Object.hasOwn(input, key) || input.evidencePreservingReducer === true)
      && (typeof input[key] !== "string" || !(input[key] as string).trim())) {
      throw new Error(`sol-omp.json: ${key} must be an explicit non-empty route`);
    }
  }
  const timeout = input.evidencePreservingReducerTimeoutMs === undefined ? 90000 : input.evidencePreservingReducerTimeoutMs;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 90000) {
    throw new Error("sol-omp.json: evidencePreservingReducerTimeoutMs must be an integer from 1 to 90000");
  }
  return Object.freeze({
    version: 1,
    observationPack: (input.observationPack as boolean | undefined) ?? false,
    actionFusion: (input.actionFusion as boolean | undefined) ?? false,
    evidencePreservingReducer: input.evidencePreservingReducer === true,
    evidencePreservingReducerTimeoutMs: timeout as number,
    ...(input.evidencePreservingReducerProvider === undefined ? {} : { evidencePreservingReducerProvider: (input.evidencePreservingReducerProvider as string).trim() }),
    ...(input.evidencePreservingReducerModel === undefined ? {} : { evidencePreservingReducerModel: (input.evidencePreservingReducerModel as string).trim() }),
  });
}

/** The caller MUST supply OMP's public, current-profile agent directory. */
export async function loadConfig(agentDir: string): Promise<{ config: SolOmpConfig; path: string }> {
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
    throw new Error("OMP did not provide an absolute agent directory; refusing to guess a config path");
  }
  const path = join(agentDir, "sol-omp.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: DEFAULT_CONFIG, path };
    }
    throw new Error(`Cannot read sol-omp configuration at ${path}`, { cause: error });
  }
  return { config: parseConfig(text), path };
}
