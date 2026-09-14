// Conservative shared policy for Codex and OMP adapters. Large size alone is
// not evidence that output is low-density or safe to summarize.
const INSPECTION_COMMAND =
  /(?:^|[;&|()]\s*)(?:cat|sed|rg|grep|head|tail|less|bat|find|fd|jq|tree|git\s+(?:diff|show|log|status|blame)|(?:\S*\/)?sol\s+observation\s+(?:read|search|meta))\b/iu;

const DIAGNOSTIC_COMMAND =
  /(?:^|[;&|()]\s*)(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check|clippy))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|go\s+test|bazel\s+test|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|check|lint|typecheck))|bun\s+(?:test|run\s+(?:test|build|check|lint|typecheck|smoke))|(?:npx|bunx)\s+(?:vitest|jest|tsc|eslint)|vitest|jest|tsc|eslint|docker\s+logs|kubectl\s+logs|journalctl)(?:\s|$)/iu;

export function isCompressibleDiagnosticCommand(command: string): boolean {
  if (!command.trim() || INSPECTION_COMMAND.test(command)) return false;
  return DIAGNOSTIC_COMMAND.test(command);
}
