# 2026-10-19 上游同步、OMP 升级与检索/统计

工作于 2026-10-19 开始，2026-10-20 收尾（Asia/Shanghai）；升级目标固定为本报告列出的提交和版本。

## 范围

- 工作区：`/home/carter003/project/sol-omp`，分支 `update/upstream-2026-10-19`，起点 `aaafd4feeea63b45a911a9ef6961abca01fb1a95`，起点工作树干净。
- SoL-Pi：`1559b5cb12c72da4a485bc50fe326586b216fb19` → [`219568034fa54ed121ede80961655e33dfb9d0e3`](https://github.com/NVlabs/SoL-Pi/commit/219568034fa54ed121ede80961655e33dfb9d0e3)。48 个新增上游提交，69 个变动文件；采用固定源码同步，没有合并上游 Git 历史。
- 根项目：SoL-Pi 0.1.1、开发依赖 Pi 1.3.0；OMP 包：18.2.5 → 18.12.2（tag commit `1d5aff90b057ce7dbfe32ea557a527c1b3144b72`）。
- 环境：Linux/WSL2 x86_64，内核 `6.18.54.1-microsoft-standard-WSL2`，Node `v24.15.0`，npm `12.1.0`，Bun `1.3.14`。
- 本轮更新 checkout 源码和本地开发依赖，没有安装/注册全局 Pi 或 OMP，没有读取或改写用户认证、配置、hooks、权限或模型路由。没有修改 Pi/OMP core，根扩展保持独立。

## 实现

根项目同步上游缓存成本和压缩决策、失败续跑、Pi 1.x/codemode、shell 继承和临时会话修复，以及 Skill/Visual 示例源码。下载归档的 94 个 Git blob 与固定 Git tree 全部匹配；本地 25 个根运行源码文件也与目标逐字节匹配。上游文件内仅保留四项有意差异：README 的 fork 导航、根测试限制在 `tests/`、npm 包检查兼容数组/对象两种报告、新 Skill 示例测试隔离运行代理环境。适配器源文件和宿主审计源文件的 SHA 见 `upstream.lock.json`。

OMP 变化：

- 新增只读 `obs_search`。区分大小写的字面量 query，至多 256 个 UTF-8 字节；分块扫描、每页至多 10 个摘录、总输出上限 16 KiB/400 行。返回匹配和摘录的原文 byte offset，支持 `next_offset` 续查与 `obs_recall` 精确回读；关闭打包后仍可恢复旧归档。不同 session 隔离，不接受任意路径，不跟随对象或归档目录符号链接。检索结果不重复打包。
- EPR 默认辅助请求门槛为 32 KiB，可明确配置回 4096；有效 receipt 至少缩小 50%，可明确配置为 0。比例检查发生在辅助调用之后，拒绝结果也保留其真实 usage 记录；这是大小策略，不能视为净费用判断。
- 新增 `SOL_OMP_USAGE` 文件日志汇总：本进程观测期的主模型、辅助请求、completed attempts、缓存 token、目录标价费用估算、累计响应耗时和观测期墙钟时间。未知/错误/取消的 usage 使总费用估算保持 null，同时保留已知部分。不从日志正文推断状态或计费，不记录提示词、命令、输出正文、凭证。不重建重启前账目，也不包含宿主没有报告的内部调用。
- 最新 OMP 仍只提供同名 `invokeTool` 委托；Action Fusion 保持 BLOCKED、配置 false，Online Context Compact 未移植。没有为了升级放开权限。

CI 分为根 Pi 与 OMP 两个 job，使用锁定依赖和审计，失败即停止后续检查；保留诊断 artifact。新增根完整检查、严格 Pi API 检查和 Skill 示例测试。未推送或运行远端 Actions，因此这里不是远端 CI 通过报告。

## 验证与失败处理

根项目的 npm 命令使用临时可写缓存 `/tmp/sol-implementation-npm-cache`，不改用户 npm 设置。

| 命令/阶段 | 实际结果 |
|---|---|
| 初始 `npm ci --ignore-scripts`、`npm run check` | PASS；原锁安装、158 tests、类型和包检查。 |
| 初始 `npm audit --audit-level=high` | FAIL，退出 1；3 high / 3 moderate。high 来自 brace-expansion、source-map-js、undici；停止后续基线验证，进入依赖修复。 |
| 同步后 `npm ci --ignore-scripts` | PASS；使用上游固定 lockfile。 |
| 同步后 `npm run check` | PASS；24 文件、268 tests、类型检查和包检查。 |
| 同步后 `npm audit --audit-level=high` | PASS，退出 0；JSON 统计全部为 0。 |
| `node scripts/check-pi-compat.mjs --strict` | PASS；明确检测 Pi 1.3.0，非零 bash 结果、output schema、codemode、ModelRegistry.complete 均符合。 |
| `npx vitest run tests/all-mechanisms.test.ts` | PASS；4 tests。 |
| 原 OMP `bun run typecheck` / `bun test` / `bun run smoke` | PASS；18.2.5、93 tests、真实开/关加载与 EOF 退出。 |
| 隔离目录 OMP 18.12.2 候选检查 | PASS；原 93 tests、类型和真实烟测；全新解析锁的审计为 0。未据此冒充正式锁已通过。 |
| 正式项目只升级 OMP 后的冻结安装与 audit | 安装 PASS，但 audit FAIL，退出 1；8 high，旧可选依赖中的 adm-zip/sharp 仍被锁定。停止验证并修复锁。 |
| `bun update --ignore-scripts` | 退出 0，但未刷新这些传递解析，不能当作告警修复。 |
| 隔离目录 `bun install --lockfile-only --ignore-scripts` | PASS；从正式项目完全相同的精确 manifest 重新解析锁，再复制回项目。不手改 node_modules 或加越界 override。 |
| 最终 `bun install --frozen-lockfile --ignore-scripts` | PASS，退出 0。transformers 4.3.1 / ONNX 1.30.0 / sharp 0.35.5 / adm-zip 0.6.1。 |
| 最终 `bun audit --audit-level=high` | PASS，退出 0；No vulnerabilities found。 |
| 最终 `bun run typecheck` / `bun test` | PASS；9 文件、103 pass / 0 fail。 |
| 最终 `bun run smoke` | PASS；真实 18.12.2 / Bun 1.3.14，打包关闭/开启、manifest/TS 两种加载、obs_recall/obs_search 来源、真实 session 路径下检索与 28,024 字节逐字节回读、正常 EOF 退出。 |
| `python3 -m unittest discover -s examples/sol-pi-skill/tests -v` 首次 | FAIL；15 项中 1 项被当前代理的 CODEX_THREAD_ID 影响，误入 Codex 分支。 |
| 示例测试隔离环境后重跑 | PASS；15 tests，同时明确覆盖环境有/无 CODEX_THREAD_ID 两种分支；没有修改运行时 host 识别逻辑。 |
| 真实模型 E2E、当前费用/速度基准 | NOT_RUN；无模型请求，无新性能收益结论。 |
| 用户级安装/全局升级/远端 CI | NOT_RUN；本轮范围为代码和 checkout 开发环境。 |

根审计的修复来自同步的新固定版本和上游传递锁，不使用 `npm audit fix --force`。OMP 依赖的最终证据以项目 `bun.lock` 冻结安装后的检查为准；隔离候选与旧锁首次失败均保留。工作流 YAML 语法和审计/冻结安装门禁静态检查 PASS；`git diff --check` PASS。

## 证据和限制

原始输出在 `/tmp/sol-implementation-20261019-h8f50ajc/`：`root-baseline-check.log`、`root-baseline-audit.json`、`root-upstream-check.log`、`root-upstream-audit.json`、`omp-candidate-smoke.log`、`omp-upgraded-stale.lock`、`omp-frozen-install.log`、`omp-final-audit.log`、`omp-resolved-tests.log`、`omp-resolved-smoke.log`、`skill-example-tests.log` 和 `skill-example-tests-fixed.log`。该临时目录不保证长期保留；关键状态、依赖锁 hash 和完整本地适配运行文件 hash 写入 `upstream.lock.json`。

烟测验证真实宿主的加载、session API 与实际归档代码，不证明模型已选择新工具，也不证明 provider 侧缓存收益或真实模型 EPR 质量。Windows、无持久 OMP session、跨机器迁移和新版本同 session 进程重启未执行。历史费用对照保持其原始版本和样本范围，不能外推至本轮。
