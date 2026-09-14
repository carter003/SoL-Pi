# Codex context-budget coupling issue

Date: 2026-09-14  
Status: confirmed; user-level Codex adapter removed pending redesign

## Summary

The Codex adapter raised both the session-level `tool_output_token_limit` and the
per-call `max_output_tokens` guidance to 12,000 so that `PostToolUse` could see a
larger tool response and preserve more evidence in Observations. In Codex, that
budget also controls how much of an unreplaced tool result is stored in model
history. The adapter therefore coupled Observation capture fidelity to main-agent
context consumption.

This becomes a large context increase whenever the Hook does not replace the
result. The current conservative density policy intentionally bypasses source,
documentation, configuration, diff, search, and ordinary read commands, including
`rg`, `grep`, `sed`, and `cat`. Those commands receive the expanded native history
budget without receiving Observation packing.

## Reproduction evidence

During a real Codex 0.154.0 session in this checkout, a combined `git status` and
`rg` inspection produced:

| Stage | Observed size |
|---|---:|
| Captured command stdout in the Codex execution event | 208,483 bytes |
| Model-facing tool response stored in history | 40,108 bytes |
| Input tokens before the next request | 16,425 |
| Input tokens on the next request | 28,326 |
| Increase | 11,901 tokens |

The increase closely matches the configured 12,000-token per-tool budget. No
Observation belonging to that active session was created. The command contained
`rg`, so `isCompressibleDiagnosticCommand()` rejected it and `handlePostToolUse()`
returned without a replacement.

This evidence does not show archived Observation content being read back into the
model. The larger raw execution event remained in the local session/event record;
the approximately 12,000-token model-facing result caused the context increase.

## Root cause

1. `PostToolUse.tool_response` normally contains the model-facing tool output,
   rather than an independent unbounded copy of process stdout/stderr.
2. Raising `tool_output_token_limit` and `max_output_tokens` therefore raises both
   the Hook-visible budget and the fallback history budget.
3. The adapter archives and replaces only explicit diagnostic commands over the
   size threshold. Inspection commands and unknown commands fail open by design.
4. Archive, reducer, timeout, parsing, and receipt-size failures also fail open,
   causing the expanded result to remain in model history.
5. The installed Hook matched only `Bash`; hosted tools and other unmatched tool
   paths were outside this protection.

## Product constraint

Configuration plus the current `PostToolUse` adapter cannot guarantee all three
properties simultaneously:

- complete arbitrary-size stdout/stderr capture;
- a small model-visible receipt;
- unchanged Codex command execution semantics.

The practical non-core-patch options are:

1. Keep ordinary tool budgets small and selectively request a larger budget only
   for commands that are guaranteed to be archived and replaced.
2. Archive and replace all sufficiently large supported tool results, with explicit
   Observation recall for source and document inspection.
3. For complete capture, move collection to a Codex App Server client that consumes
   `item/commandExecution/outputDelta`, then correlate that archive with a concise
   model-visible result.

## Removal performed

Pending redesign, the user-level Codex integration was removed:

- removed the SoL `PostToolUse` entry from `~/.codex/hooks.json`;
- removed `tool_output_token_limit = 12000` from `~/.codex/config.toml`;
- removed the corresponding PostToolUse trust-state entry;
- removed the SoL-managed `~/.codex/AGENTS.md` block that required every
  `exec_command` and `write_stdin` call to request 12,000 output tokens.

The pre-existing user `SessionStart` Hook and its trust state were preserved.
Existing Observation artifacts were retained as diagnostic evidence. No Codex or
Pi source was modified.
