# 2026-11-03 上游同步、Pi 1.5.0 与 OMP 18.16.0 升级

工作于 2026-11-03 执行（Asia/Shanghai）；升级目标固定为本报告列出的提交和版本。

## 范围

- 工作区：`/home/carter003/project/sol-omp`，分支 `update/upstream-2026-11-03`，起点 `ede66764669fd56c7c8e09d5a9c04b62077d48cd`，起点工作树干净。
- NVIDIA SoL-Pi：`219568034fa54ed121ede80961655e33dfb9d0e3`，官方 HEAD/main 经 `git ls-remote` 核对一致，0 领先提交。
- Pi 核心：升级 `@earendil-works/pi-*` 开发依赖由 `1.3.0` → `1.5.0`。
- OMP 宿主：升级 `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-ai` 由 `18.12.2` → `18.16.0`（tag `v18.16.0`，commit `650f3a108229ee11bf68ba3377f4e8c3391cd424`）。
- Bun 运行时：由于 OMP 18.16.0 引入了 `Bun.semver.order(Bun.version, "1.4.4") < 0` 强制门禁，升级系统与配置中的 Bun 运行时由 `1.3.14` → `1.4.4`。

## 适配与变动

1. **Pi 1.5.0 适配**：
   - 适配 `scripts/check-pi-compat.mjs` 测试矩阵（`TESTED_PI_VERSIONS` 增加 `"1.5.0"`）。
   - 更新安装与兼容性文档：`agents-install.md`、`README.md`、`docs/compatibility.md`、`THIRD_PARTY_NOTICES.md`。
   - 修复测试环境主题未初始化问题：Pi 1.5.0 的 `write` 工具渲染器新增代码语法高亮，调用 `highlightCode` 时访问全局主题代理，若未调用 `initTheme()` 会抛出 `Error: Theme not initialized. Call initTheme() first.`。在 `tests/helpers.ts` 中安全引入并调用 `initTheme?.()`，确保在任何测试及离线场景中安全回退。
2. **OMP 18.16.0 适配与漏洞审计**：
   - 升级 `sol-omp/package.json` 中的 `peerDependencies` 与 `devDependencies` 至 `18.16.0`。
   - 审计修复：OMP 传递依赖中的 `chromium-bidi` 依赖旧版本 `zod`（存在 GHSA-mrhx-c7xc-m3w5 内存耗尽高危漏洞），在 `sol-omp/package.json` 中配置 `"overrides": { "zod": "4.6.7" }`，重新生成 `bun.lock` 并进行冻结安装，使得 `bun audit --audit-level=high` 达到 0 漏洞。
   - CI 工作流更新：`.github/workflows/sol-omp-check.yml` 中的 `bun-version` 更新为 `1.4.4`。
   - Action Fusion 状态：经核对 OMP 18.16.0 `ExtensionContext.invokeTool` 与 `ExtensionAPI`，仍仅提供同名工具委托，保持 **BLOCKED / actionFusion=false**。

## 验证矩阵

| 命令 / 阶段 | 实际结果 | 说明 |
|---|---|---|
| `npm run check` (根目录) | PASS | 24 文件、268 项 Vitest 测试全部通过；类型检查与 `npm pack --dry-run` PASS。 |
| `node scripts/check-pi-compat.mjs --strict` | PASS | 严格模式通过；明确识别 Pi 1.5.0，结构化 exitCode=3、outputSchema、codemode、ModelRegistry.complete 符合。 |
| `npx vitest run tests/all-mechanisms.test.ts` | PASS | 4 项全机制配置测试通过。 |
| `python3 -m unittest discover -s examples/sol-pi-skill/tests -v` | PASS | 15 项测试全部通过（隔离 CODEX_THREAD_ID）。 |
| `npm audit --audit-level=high` | PASS | 0 high / 0 critical（退出码 0）。 |
| `cd sol-omp && bun run typecheck` | PASS | TypeScript 5.8.3 类型检查零错误。 |
| `cd sol-omp && bun test` | PASS | 9 文件、103 项测试全部通过（0 失败）。 |
| `cd sol-omp && bun run smoke` | PASS | 真实 OMP 18.16.0 / Bun 1.4.4 加载验证；ObservationPack 开/关双模式正常加载、obs_recall 与 obs_search 工具注册、真实 session 路径下归档检索与 28,024 字节逐字节回读通过、EOF 正常退出。 |
| `cd sol-omp && bun audit --audit-level=high` | PASS | No vulnerabilities found（检查 145 个包，退出码 0）。 |
