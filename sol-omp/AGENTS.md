# sol-omp adapter scope

For this directory, follow `docs/implementation-plan-mvp.md` and `README.md`.
This is a separate OMP adapter, not the root project's original-Pi, all-four-mechanisms installation.
Do not install the original Pi runtime or enable root SoL-Pi's four features to test this adapter.
Do not patch OMP core/node_modules, bypass approval, modify user authentication, or overwrite unrelated changes.
Preserve the selected NVIDIA source and license; record changes in `UPSTREAM.md` and `upstream.lock.json`.

Run `bun run typecheck`, `bun test`, and `bun run smoke` on the pinned installation.
`node --experimental-strip-types --test tests/*.test.ts` is a fallback UNIT test only.
The fake-API unit tests and TypeScript syntax checks do not prove OMP compatibility.
Keep Action Fusion disabled until a public dispatch preserves BOTH command approval and tool_call interception.
Report PASS/FAIL/BLOCKED/NOT_RUN honestly; runtime verification must be evidenced by real command results, not inferred from CI configuration.
