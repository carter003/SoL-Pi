import type { ArchiveObject } from "../upstream/sol-pi/evidence-preserving-reducer/archive.ts";
import { REDUCER_RECEIPT_SCHEMA, sha256 } from "../upstream/sol-pi/evidence-preserving-reducer/config.ts";
import {
  type EvidenceKind,
  type ValidatedReceipt,
  validateReceipt,
} from "../upstream/sol-pi/evidence-preserving-reducer/receipt.ts";
import type { CodexObservationMeta } from "./observation-store.ts";

export const CODEX_EPR_RECEIPT_PREFIX = "sol_codex_evidence_receipt_v1";
const MAX_ITEMS = 10;
const MAX_QUOTE_CHARS = 320;

interface EvidenceCandidate {
  readonly kind: EvidenceKind;
  readonly line: number;
  readonly quote: string;
  readonly priority: number;
}

export interface CodexEvidenceReduction {
  readonly exitCode: number | null;
  readonly exitCodeAvailable: boolean;
  readonly receipt: string;
  readonly validated: ValidatedReceipt;
}

const SIGNALS: ReadonlyArray<{ kind: EvidenceKind; priority: number; pattern: RegExp }> = [
  { kind: "fatal", priority: 0, pattern: /\b(?:fatal|panic|segmentation fault|unhandled exception)\b/iu },
  { kind: "failure", priority: 1, pattern: /\b(?:error|failed|failure|assert(?:ion)?|expected|actual|not ok|tests? failed)\b/iu },
  { kind: "warning", priority: 3, pattern: /\bwarn(?:ing)?\b/iu },
  { kind: "target", priority: 4, pattern: /(?:^|\s)(?:at\s+[^\n]+|[^\s:]+\.(?:[cm]?[jt]sx?|rs|go|py|java|kt|c|cc|cpp|h):\d+(?::\d+)?)/u },
  { kind: "summary", priority: 5, pattern: /\b(?:pass(?:ed)?|tests?|suites?|duration|time|completed|finished)\b/iu },
];

function safeQuote(line: string): string {
  if (line.length <= MAX_QUOTE_CHARS) return line;
  let end = MAX_QUOTE_CHARS;
  const finalCodeUnit = line.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--;
  return line.slice(0, end);
}

function candidatesFor(body: string): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  const seen = new Set<string>();
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    for (const signal of SIGNALS) {
      if (!signal.pattern.test(line)) continue;
      const quote = safeQuote(line);
      const key = `${signal.kind}\0${quote}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ kind: signal.kind, line: index + 1, quote, priority: signal.priority });
      }
      break;
    }
  }
  const nonempty = lines.map((line, index) => ({ line, index })).filter(item => item.line.trim());
  for (const item of [nonempty[0], nonempty.at(-1)]) {
    if (!item) continue;
    const quote = safeQuote(item.line);
    const key = `summary\0${quote}`;
    if (!seen.has(key)) candidates.push({ kind: "summary", line: item.index + 1, quote, priority: 6 });
  }
  return candidates.sort((left, right) => left.priority - right.priority || left.line - right.line).slice(0, MAX_ITEMS);
}

function renderReceipt(meta: CodexObservationMeta, validated: ValidatedReceipt, statusSource: string): string {
  const status = meta.exitCodeAvailable ? validated.status : "unknown";
  const failureSignalsObserved = validated.evidence.some(item => item.kind === "fatal" || item.kind === "failure");
  const lines = [
    CODEX_EPR_RECEIPT_PREFIX,
    `observation_id=${meta.id}`,
    `status=${status}`,
    `status_source=${statusSource}`,
    `uncertain=${validated.uncertain}`,
    `failure_signals_observed=${failureSignalsObserved}`,
    `tool=${meta.tool}`,
    `command=${JSON.stringify(meta.command)}`,
    `exit_code=${meta.exitCode ?? "unknown"}`,
    `source_sha256=${meta.rawSha256}`,
    `source_bytes=${meta.rawBytes}`,
    `source_lines=${meta.rawLines}`,
    "verified_evidence:",
  ];
  for (const item of validated.evidence) {
    lines.push(`- kind=${item.kind} line=${item.line} quote_sha256=${item.quoteSha256} quote=${JSON.stringify(item.quote)}`);
  }
  if (!validated.evidence.length) lines.push("- none");
  lines.push(
    "warning=Quotes are byte-preserved evidence, not proof of completeness; omitted failures may exist",
    `retrieve=sol observation search ${meta.id} --query <term> --context-lines 3`,
    `read=sol observation read ${meta.id} --offset 0 --max-bytes 12000`,
  );
  return lines.join("\n");
}

/** Local deterministic EPR: exact quotes are passed through the same SoL receipt validator used by OMP. */
export function reduceCodexObservation(meta: CodexObservationMeta, body: string): CodexEvidenceReduction {
  // Tool output is untrusted content. Strings such as `process.exitCode = 1`
  // in source or logs are evidence, never authoritative process metadata.
  const exitCode = meta.exitCodeAvailable ? meta.exitCode : null;
  const selected = candidatesFor(body);
  const hasFailureSignal = selected.some(item => item.kind === "fatal" || item.kind === "failure");
  const isError = exitCode !== null ? exitCode !== 0 : hasFailureSignal;
  if (isError && !selected.some(item => item.kind === "fatal" || item.kind === "failure")) {
    const bodyLines = body.split("\n");
    let fallback: string | undefined;
    for (let index = bodyLines.length - 1; index >= 0; index--) {
      if (bodyLines[index]?.trim()) { fallback = bodyLines[index]; break; }
    }
    if (fallback) selected.unshift({ kind: "failure", line: body.split("\n").lastIndexOf(fallback) + 1,
      quote: safeQuote(fallback), priority: 0 });
  }
  const archive: ArchiveObject = {
    hash: meta.rawSha256,
    bytes: meta.rawBytes,
    chars: meta.rawChars,
    lines: meta.rawLines,
    path: "raw.txt",
  };
  const rawReceipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: archive.hash,
    status: isError ? "failure" : "success",
    uncertain: exitCode === null || (exitCode === 0 && hasFailureSignal),
    evidence: selected.slice(0, MAX_ITEMS).map(item => ({ kind: item.kind, quote: item.quote })),
  });
  const checked = validateReceipt(rawReceipt, archive, body, isError);
  if (!checked.ok) throw new Error(`EPR receipt validation failed: ${checked.reason}`);
  const patchedMeta = { ...meta, exitCode, exitCodeAvailable: exitCode !== null };
  return {
    exitCode,
    exitCodeAvailable: exitCode !== null,
    validated: checked.value,
    receipt: renderReceipt(patchedMeta, checked.value, exitCode !== null ? "tool-response-metadata" : "unavailable"),
  };
}
