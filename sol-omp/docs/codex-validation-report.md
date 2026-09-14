# Codex adapter validation report

Date: 2026-09-14  
Codex CLI: `0.154.0`  
Runtime: Bun `1.3.14`, Node.js `v24.15.0`

## Result

The optimized MVP passes its scoped target behavior without MCP or a Codex source patch:

```text
eligible low-density diagnostic Bash
  -> synchronous PostToolUse hook
  -> archive the tool_response visible to the hook
  -> validated local EPR receipt
  -> decision:block feedback
  -> next model request sees the receipt and observation ID
```

The compatibility mechanism is `decision:"block"`, not a clean successful-result rewrite. Codex marks the completed tool call as rejected/error, although the command has already run. This is the cost of avoiding a Codex patch with the behavior observed in 0.154.0.

### Density and status correction

The first user-wide revision compressed every Bash result at or above 4 KiB. A real repository inspection exposed two unacceptable effects: dense TypeScript/Markdown/configuration output was reduced, and strings such as `process.exitCode = 1` inside inspected source were mistaken for the shell status. Five status-bearing observations in that session were affected by this content/status ambiguity.

The current revision is conservative:

- only explicit test, build, compiler, typecheck, lint, and runtime-log commands are eligible;
- source, Markdown, configuration, diff, search, and ordinary read commands remain entirely on the native path, even above 4 KiB;
- a compound command containing an inspection command is also excluded;
- process status is accepted only from numeric structured tool-response metadata; output text never supplies it;
- absent structured metadata remains `status=unknown` and `exit_code=unknown`.

A real trusted Hook replay of the former 7,434-byte `sed` inspection returned all 137 lines with exit 0 and created no block receipt. A separate 11,194-byte synthetic `bun test` log still produced an observation receipt, while an embedded `process.exitCode = 1` string left status unknown. `decision:"block"` remains a known presentation limitation for eligible logs.

## End-to-end evidence

A fresh `codex exec` process ran a synthetic native Bash command that emitted 28,700 bytes and exited with status 1. The output contained a unique middle sentinel and an error at `src/payment.ts:73:11`.

Observed stages:

| Stage | Bytes | Result |
|---|---:|---|
| Native process/UI event | 28,700 | Full generated stream was observable outside the next model request |
| `PostToolUse.tool_response` | 8,107 | Codex had already truncated it; the middle sentinel and error were absent |
| SoL EPR receipt | 1,106 | Stored as `reduced.txt` and substituted as block feedback |
| Final model response | n/a | Reported `sol_codex_evidence_receipt_v1`, observation `obs_0b6ff56b135e22109141cb14`, and `status=unknown` |

The archived metadata recorded the exact hook input hash `c5b270b2afe527f294df97edf68820f158159a3e9aa307e37cb38b9eaf737e40`, 8,107 raw bytes, 198 lines, and `captureComplete:"unknown"`. Because Codex removed both the explicit exit status and the middle failure before the hook, EPR correctly returned:

```text
status=unknown
status_source=unavailable
uncertain=true
failure_signals_observed=false
```

This demonstrates context reduction for the subsequent model request. It also establishes the baseline behavior when the per-call output budget is left at its smaller default.

### Output-budget follow-up

The documented top-level history budget was first tested by itself:

| Configuration path | Hook bytes | Hook lines | Middle error present |
|---|---:|---:|---|
| temporary Codex home: `tool_output_token_limit = 12000` | 8,107 | 198 | No |
| CLI: `-c tool_output_token_limit=12000` | 4,107 | 100 | No |

Both responses retained a mechanical head/tail excerpt and reported the original 7,175-token count. Therefore the top-level setting alone does not reliably widen the native Bash payload delivered to `PostToolUse` in Codex 0.154.0 and must not be represented as a complete-capture guarantee.

Source inspection then identified the missing variable: `ExecCommandToolOutput.model_output_policy()` applies the smaller of the session `tool_output_token_limit` and the per-call `max_output_tokens`. A second fresh `codex exec` process used both:

```text
tool_output_token_limit = 12000
exec_command.max_output_tokens = 12000
```

| Stage | Bytes / lines | Middle error present |
|---|---:|---|
| Native command output | 28,700 / 700 | Yes |
| `PostToolUse.tool_response` | 28,700 / 700 | Yes |
| SoL receipt | reduced | Yes: `src/payment.ts:73:11 ERROR expected 200 but actual 503` |

The final model reported observation `obs_5b87a083a7789564eb163f44`, `source_bytes=28700`, and the expected/actual evidence. This proves complete Hook capture for this 7,175-token fixture and context replacement by the EPR receipt. It does not guarantee arbitrary output completeness: the caller can omit or lower `max_output_tokens`, the 12K budget can itself be exceeded, and the unified-exec collector has a separate approximately 1 MiB cap.

The Hook still reported `exit_code=unknown`, including when the native command exited 1. Current Codex sends the truncated/model-facing output body to `PostToolUse`, not the structured exit-code field held internally.

### User-wide installation and project isolation

The user installer was run against the real Codex home and preserved the existing `SessionStart` hook while adding one `PostToolUse` entry. A fresh Codex 0.154.0 process launched from an independent Git repository then produced:

| Check | Result |
|---|---|
| Native/Hook-visible output | 28,714 bytes / 700 lines |
| Stored EPR receipt | 1,254 bytes |
| Middle evidence | Preserved: `src/payment.ts:73:11 ERROR expected 200 but actual 503` |
| Observation | `obs_1abc4eb73a374e9d1188703b` |
| Model-visible continuation | Receipt only |
| Read same ID from a second Git project | Blocked by project namespace |

The first E2E used `--dangerously-bypass-hook-trust` only after inspecting the installed command. The installed hook was then reviewed and trusted through Codex's own interactive trust UI, without synthesizing its internal hash. A subsequent fresh `codex exec` used no trust-bypass option and produced observation `obs_885a6c052c06927378c58f9f`, preserving the exact `src/trust.ts:9:2 ERROR expected enabled actual disabled` evidence. No review or bypass warning occurred.

## Hook control probes

Using the same real CLI path:

| Hook stdout | Hook ran | Replaced next model-visible result |
|---|---|---|
| `{"continue":false,"stopReason":"..."}` | Yes | No |
| `{"continue":false,"reason":"..."}` | Yes | No |
| `{"decision":"block","reason":"..."}` | Yes | Yes |

The first two forms are documented control fields but did not replace this native Bash result in the tested CLI path. The third form is therefore pinned as an explicitly tested compatibility behavior, with a regression test asserting its JSON shape.

## Automated validation

- `bun run typecheck`: PASS
- `bun test`: PASS, 82 tests across 7 files, including dense-input bypass, diagnostic eligibility, structured-only status, user-install merge/idempotency, and canonical project-isolation coverage
- `bun run smoke`: PASS for real OMP 18.1.19 load and graceful shutdown; this is not an OMP model E2E
- Codex adapter unit tests cover the 4 KiB boundary, exact raw persistence, dense source/document bypass, low-density diagnostic selection, receipt validation, structured-only status handling, paged reads, literal search, and recall recursion avoidance

## Environment limitation

The container did not permit a nested Codex sandbox (`codex exec` exited 101 while trying to establish its own sandbox). The isolated synthetic E2E therefore used Codex's explicit sandbox-bypass mode solely to test hook ordering and model-visible replacement. The adapter itself does not execute the command and does not change Codex's configured sandbox or approval path; that claim follows from architecture and code inspection, not from a nested-sandbox runtime pass in this environment.
