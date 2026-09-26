# 2026-09-26 SoL-Pi 上游同步

## 范围和版本

- 同步验证时的工作区：`/home/carter003/project/sol-omp`；分支 `main`；Git HEAD `d33058707eff3282c4420fc17921b8e1058e8ce9`。
- 原来源基线：`d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`。
- 当前来源基线：[`NVlabs/SoL-Pi@1559b5cb12c72da4a485bc50fe326586b216fb19`](https://github.com/NVlabs/SoL-Pi/commit/1559b5cb12c72da4a485bc50fe326586b216fb19)，上游提交日期 2026-09-22。
- [上游比较](https://github.com/NVlabs/SoL-Pi/compare/d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0...1559b5cb12c72da4a485bc50fe326586b216fb19)：13 个提交（含 merge），15 个文件；其中已有改动不重复应用。
- 同步验证阶段保留既有 15 个未提交文件；仅对其中 README、UPSTREAM、验证报告和来源锁追加本轮记录，其余原有改动不变。随后按用户要求在 `update/sol-pi-2026-09-26` 分支组织 GitHub 交付：第一项提交保存原有 OMP 18.2.5 / UTF-8 recall / 启动提示快照，第二项提交包含本轮上游同步。上游采用源码同步，未合并其 Git 提交历史。
- 仅验证源码及现有固定 OMP 适配器；未注册新安装、修改实际用户配置、认证、Pi/OMP core 或手动修改 `node_modules`。根依赖按既有 lockfile 重新安装；两份依赖锁和依赖版本均未变。

## 同步内容与适配结论

| 上游变化 | 本地处理 |
|---|---|
| Reducer provider/model 去除首尾空白 | 同步根配置解析器和配置检查脚本及上游测试。OMP 已有 trim；新增回归覆盖普通/Unicode 空白归一化及纯空白拒绝，无需改动适配器运行代码。 |
| Action Fusion Unicode 空格和 Windows shell 路径归一化 | 同步根 `file-queue.ts`、路径测试和兼容说明。OMP 未移植此模块；保持禁用，不绕过宿主审批或拦截。 |
| Pi 0.85.1 和包集成检查 | 此前已同步；保留固定版本。保留 fork 的 `vitest run --dir tests`，防止根测试误收集 Bun 适配器测试。 |
| 论文链接 | 更新 README 徽标和正文。三方比较产生的两个 README 冲突经逐项检查，均为已部分同步的徽标/论文文本，采用最新上游文本。 |
| ObservationPack / EPR / runtime-paths / LICENSE | 10 项来源映射的 Git blob 与旧基线全部相同。保留现有归档、UTF-8 recall、首次投影、artifact 恢复、EPR 生命周期及 Codex 适配。 |

通过目标提交的递归 Git tree 逐项计算本地 Git blob：上游 65 个文件中 63 个完全一致，包含全部 23 个 `src/sol-pi/` 运行源码文件。剩余两个文件是刻意保留的 fork 差异：`package.json` 限制根测试范围；`tests/package.test.ts` 支持 npm 包检查返回的数组/对象两种格式。

`upstream.lock.json` 更新当前来源提交，保留原始 fork 基线及历史证据。全部来源 blob 和本地适配 SHA-256 已复核；`src/omp/evidence-preserving-reducer.ts` 的旧本地 hash 过期，修正为 `383cce7564aadf1521b6e022c223e8f8de1e348081dc2d3728818a0c83e4c137`，该文件内容未变。

## 实测结果

环境：Linux/WSL2 x86_64，内核 `6.18.40.1-microsoft-standard-WSL2`；Node `v24.15.0`，npm `12.1.0`，Pi 开发依赖 `0.85.1`，OMP 本地包 `18.2.5`，Bun `1.3.14`。

根目录执行：

| 命令 | 结果 |
|---|---|
| `npm ci --ignore-scripts --cache /tmp/sol-upstream-npm-cache` | PASS；遵循既有 lockfile，退出 0。 |
| `npm run check`（首次） | FAIL；155 项通过、包检查套件失败、3 项跳过。嵌套 `npm pack` 尝试写入只读默认 `/home/carter003/.npm`，报 EROFS；尚未执行后续 audit。 |
| `npm_config_cache=/tmp/sol-upstream-npm-cache npm run check` | PASS；类型检查、19 个文件共 158 项测试、包内容检查均通过，退出 0。只调整进程缓存位置，未改测试断言。 |
| `npm audit --audit-level=high --cache /tmp/sol-upstream-npm-cache` | PASS（high 门槛），退出 0；0 high/critical，仍有 2 moderate。 |
| `node scripts/check-pi-compat.mjs` | PASS，退出 0。 |
| `npm_config_cache=/tmp/sol-upstream-npm-cache npx vitest run tests/all-mechanisms.test.ts` | PASS；4 项通过，退出 0。 |

`sol-omp/` 执行：

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | PASS，退出 0。 |
| `bun test` | PASS；7 个文件共 93 项通过，0 失败，退出 0。 |
| `bun run smoke` | PASS；固定 OMP 18.2.5 / Bun 1.3.14，ObservationPack 关闭/开启、目录 manifest/显式 TS 入口均正常加载，`obs_recall` 注册及 session API 探针通过，真实 EOF 正常退出。 |
| `bun audit --audit-level=high` | NOT_RUN；本轮没有修改 OMP 依赖。历史 adm-zip/sharp 共 3 项 high 记录保留，不能视为已解决。 |
| 真实模型 E2E | NOT_RUN；没有发送模型请求，烟测仅证明真实宿主加载和退出。 |

根 audit 的两个 moderate 来自 Vitest / `@vitest/mocker`，对应 [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。npm 提示修复需要越过当前精确依赖版本；本轮保持上游锁定依赖，没有执行强制升级。

本地原始输出、更新前文件 hash、原有差异备份、三方候选和 Git tree 证据位于 `/tmp/sol-upstream-20260926-362ysszb/`。该目录是临时证据，不保证长期保存。关键结果保存在本报告和 `upstream.lock.json`。

Windows 路径分支由上游测试在当前 Linux 进程中模拟平台覆盖，本轮未在原生 Windows 上执行。未扩大支持版本或宣称四项机制均已移植至 OMP。
