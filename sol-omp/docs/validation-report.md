# sol-omp 验证报告

## 原生 eval 融合：本轮配置、运行及对照

日期：2026-09-12。用户要求 Action Fusion 跑通后，经当前宿主与官方发布复核，明确选择 **OMP 原生 eval 顺序融合替代方案**。结论：**原生路径配置与已测行为 PASS；减少模型往返已验证；sol-omp Action Fusion 仍 BLOCKED、未启用。**

### 配置及不变项

当前用户默认 profile，配置文件 `/home/carter003/.omp/agent/config.yml`：

| 设置 | 修改前 | 最终 |
|---|---|---|
| `providers.openai-codex.codeMode` | off | **on** |
| `bash.autoBackground.enabled` | true | **false** |
| `eval.autoBackground.enabled` | false | false，不变 |
| `tools.approvalMode` | yolo | yolo，不变 |
| `tools.approval` | `{}` | `{}`，不变 |

使用 `omp config set providers.openai-codex.codeMode on`、`omp config set bash.autoBackground.enabled false`，均 exit 0；逐项 `omp config get ... --json` 验证最终值。实际模型工具面已不直接暴露 edit/bash，测试通过 eval 调用它们。关闭 bash 自动后台化的行为变化是长命令等待结束/超时；显式后台调用仍然可用。

`/home/carter003/.omp/agent/sol-omp.json` 保持 `observationPack=true, actionFusion=false`；原有插件、认证、模型选择和审批政策保留。OMP 与 npm 包仍为 18.1.18，Bun 1.3.14，Node 24.15.0；实际模型 `openai-codex/gpt-6-astra`，high。未改 OMP core/node_modules、原版 SoL-Pi 或适配包运行源码。

### 实際行为验证

每个场景均为真实 OMP RPC 进程、真实模型调用、临时目录中的原生工具操作。测试扩展只记录事件，并在拦截场景明确拒绝 bash，不提供替代编辑器或命令执行器。没有关闭原有扩展或使用 `--auto-approve`。一次性配置 overlay 在指定场景要求 bash 审批/deny，未写入用户永久权限设置。

| 场景 | 结果 | 可观察证据 |
|---|---|---|
| 一个 eval 内 read → edit → bash | PASS | 真实快照生成 hashline 编辑，文件改变，Node 验证完成；各内层工具调用一次 |
| 一个 eval 内 write → bash | PASS | 原生 write 修改文件，验证器实际启动一次并通过 |
| 编辑失败 | PASS | 使用真实快照但超出行范围的修改被拒绝；原文件不变，bash 未调用 |
| 命令 exit 7 | PASS | 编辑保留；验证器启动一次，真实退出码 7，eval 桥接 hasError=true，模型收到错误并停止 |
| 配置禁止 bash、允许 edit | PASS | 编辑完成，bash 在 tool_call 前被 deny，验证器未启动 |
| 独立 bash 审批通过 | PASS | edit 已完成、命令未启动时收到 bash 审批；RPC 选择 Approve 后才启动一次 |
| 独立 bash 审批拒绝 | PASS | edit 已完成，RPC 选择 Deny 后命令未启动 |
| 扩展 tool_call 阻断 bash | PASS | 收到内层 bash 事件，返回 block 后命令未启动 |
| 等待 bash 批准时取消 | PASS | 真正 RPC abort；批准未发生，命令未启动，成功编辑保留 |
| bash 已开始运行后取消 | PASS | 观察到进程启动标记后 RPC abort；等过命令原计划完成时刻仍无完成标记，编辑保留 |
| bash 一秒超时 | PASS（最终同步配置） | 真实 timedOut 结果传至模型为错误；等过原计划完成时刻仍无完成标记，编辑保留 |

所有验收场景均未发生重复编辑或重复启动命令，OMP 正常退出为 0。这里的 PASS 指故意失败/拒绝/取消路径行为符合预期，不是命令全部 exit 0。权限、编辑失败等短场景在自动后台化修改前完成；关闭自动后台化后重跑了成功对照、超时和运行中取消。

### 首次失败及处理

1. **宿主事件错误标记不一致，未修 core。** 最初命令失败检查因信任 `tool_result.isError` 而使测试驱动 exit 1。实际 bash 已 exit 7，但该事件顶层为 false；eval 事件顶层也可能为 false，而其 `details.isError`、桥接 `hasError` 和最终 session toolResult 的错误状态均为 true。保留首次失败证据并通过 `report_issue` 记录宿主问题；改为核对实际退出码、桥接及最终模型错误状态后重跑通过。安全顺序代码必须检查工具桥接返回的 `hasError`，不能仅用 try/catch 或 observer 顶层标记。
   源码复核还发现：若 tool_result 处理器返回改写后的内容，却不明确保留错误状态，包装层可能丢失原结果的错误标记。当前已核查的 ObservationPack 只处理 context，dummypi 为空入口，不走此路径；这不构成对所有扩展的安全保证。后续 Reducer 不应只依赖该事件布尔值，也不能让日志改写把失败变成成功。
2. **自动后台化破坏同步返回，已配置修正。** 初次一秒超时场景，即使 `async:false`，bash 仍先返回 `details.async.state=running`，超时结果在后续自动消息到达；测试驱动 exit 1。模型明确报告尚未完成，没有假报成功。将用户级 `bash.autoBackground.enabled` 设为 false 后，超时在该 eval 内成为失败结果，重跑 PASS。

这两次失败没有从记录中删除。首次原始结果及修正后的场景名均保存在结构化证据。此前依赖审计的 3 项 high 告警仍未解决，本轮未重跑或改记 PASS；测试仅涉及隔离的合成文件与 Node 验证器，不处理 ZIP 或图像。

### 三对最终配置对照

全部采用最终 Code Mode on、bash/eval 自动后台化 off 的配置，ObservationPack 保持开启。每个样本同一用户任务，把 `target.txt` 第 2 行 `old` 改为 `new`，然后 Node 验证文件内容。分步组按提示使用两个 eval（read+edit / bash），融合组按提示使用一个 eval（read+edit+bash）；两组使用同样的错误 guard 和真实原生工具，不跳过验证。

| 指标 | 分步基线 | 单元内融合 | 变化 |
|---|---:|---:|---:|
| 每任务模型可见 eval 调用 | 2 | 1 | −50% |
| 每任务模型响应，含最终答复 | 3 | 2 | −33.3% |
| 每任务真实 read/edit/bash 调用 | 3 | 3 | 不变 |
| 三样本累计 token，含缓存读取 | 106,542 | 70,839 | **−33.5%** |
| 每任务平均耗时 | 18.70 s | 15.25 s | 约 −18.5% |
| 三样本宿主标价估算合计 | 0.392700 | 0.442502 | **+12.7%** |

费用未达到“省钱”预期：分步组累计非缓存输入 26,144 / cacheRead 79,360，融合组 36,091 / cacheRead 33,792，缓存比例不同；第一对分步组的标价估算显著较低。没有挑掉该样本或只展示后两对。OMP 标价估算不是实际账单。

并发配对运行受网络、调度、供应商缓存影响，只有三对合成样本；耗时不是稳定延迟承诺。提示要求执行给定代码，证明的是可控顺序融合机制，不是模型在任意自主编码任务中都会自动融合。结论为 **少一次模型往返已实现，底层工作不减少，普遍省钱未证实**。

### 回归、复现与证据

- 最终 `bun run typecheck`：PASS；`bun test`：36 pass / 0 fail；`bun run smoke`：两个固定 npm 宿主开关加载与正常退出 PASS。它们不替代上述实际独立二进制模型测试。
- [native-fusion-comparison-2026-09-12.json](native-fusion-comparison-2026-09-12.json)：最终配置、每对 usage/会话 ID、审批响应、变更/命令次数、取消/超时证据与首次失败。
- 私有临时证据：`/tmp/sol-omp-action-fusion-ijvftgcm/<run>/`，含完整 prompt、RPC/扩展事件、session 记录；可能被系统清理。临时驱动及探针验证后移除，不安装测试扩展。
- 日常使用与恢复原配置命令见 [README 的原生融合说明](../README.md#omp-原生-eval-顺序融合独立替代方案)。审批保证仅针对原生 `tool.*` 通道，不包括原始 fs/Bun.$；该方案没有 sol-omp then_run、专属队列或执行前外部改动检查。
- 本轮只改 OMP 上述两个用户设置，更新说明/阻塞报告并新增 JSON 证据。按用户要求提交说明与脱敏实测数据；运行源码不变，用户配置、认证和临时日志不入库。任务开始前已有的未跟踪 bun.lock 保留，不纳入本次提交。

---

## ObservationPack 用户级安装与真实模型对照（此前完成）

日期：2026-09-12。结论：**ObservationPack 安装及已测功能 PASS；安全审计 FAIL，用户明确接受风险后继续只读测试；并非上游四项机制完整适配。**

### 安装状态

- checkout：`/home/carter003/project/sol-omp`；适配包：`/home/carter003/project/sol-omp/sol-omp`。
- 当前分支 `main`，commit `08236ca26f83775e961167d9cefbc38d75027454`。开始时仅 `?? sol-omp/bun.lock`；该用户已有锁保留不变。
- Linux/WSL2 x86_64；Node `v24.15.0`、npm `12.0.2`、Bun `1.3.14`。本地 npm OMP 与实际 PATH 独立二进制均报告 `18.1.18`。
- 实际客户端：`/home/carter003/project/erp-1123/scripts/herdr-tps/.runtime/omp`；没有改写客户端、OMP core/node_modules 或原版 SoL-Pi。
- 用户明确选择 **user 范围，默认 profile**。`omp plugin list --json` 显示 `sol-omp@0.1.0-dev.0`，路径 `/home/carter003/.omp/plugins/node_modules/sol-omp` 链接至上述适配包；原有 `dummypi@0.0.1` 保留且启用。
- 宿主公开 API 实际解析配置为 `/home/carter003/.omp/agent/sol-omp.json`：`{"version":1,"observationPack":true,"actionFusion":false}`。
- 真实加载探针确认恰好一个 `obs_recall`，来源为该链接；`edit`、`write` 保持 builtin。未覆盖认证、模型或权限设置，未使用 `--auto-approve`。
- 新启动的普通 `omp` 自动加载，不需要额外 `--extension`；已有会话需重启。其他 profile 不在本次配置范围内，源码目录必须保留。

根目录 `agents-install.md` 面向原版 Pi 的安装命令按 `sol-omp/AGENTS.md` 明确排除；本轮没有混装 Pi 0.84.2 或开启原版四功能配置。

### 实际命令和检查

以下 Bun 命令在 `sol-omp/` 执行：

| 命令/场景 | 状态 | 证据 |
|---|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | PASS | exit 0，153 installs / 184 packages，no changes |
| `bun run typecheck` | PASS | `tsc --noEmit`，exit 0 |
| `bun test` | PASS | 36 pass / 0 fail，3 个文件；包含故障保留原文的负向用例 |
| `bun run smoke` | PASS | npm 固定宿主开关两种真实加载、公共路径、工具注册、EOF 正常退出 |
| `omp plugin link /home/carter003/project/sol-omp/sol-omp --scope user` | PASS | 用户级持久链接 |
| `omp plugin list --json` | PASS | 两个插件均启用，新增来源与预期相同 |
| 实际独立二进制自动发现插件，无模型提示词 | PASS | exit 0；配置、工具来源和原生 edit/write 探针通过 |
| 实际模型关闭/开启对照 | PASS | 两组均无模型或工具错误，exit 0；恢复中间标记 |
| 真正退出并恢复同一 session | PASS | 新进程中同 ID 三页逐字节恢复，exit 0 |
| 关闭打包后恢复同一 session | PASS | 旧 ID 仍恢复；新观察连续 5 次投影均全文；exit 0 |
| 原生 `read` → 占位 → `obs_recall` | PASS | 默认截断与显式完整范围两种实际工具观察均逐字节恢复，exit 0 |
| `bun audit --audit-level=high` | **FAIL** | exit 1，3 项 high 告警；风险保留，未修复 |

配置探索时 `omp config get model --json` 返回 unknown setting、exit 1；改用正确的 `omp config get modelRoles --json` 成功，未改动模型配置。该探索失败不作为已通过检查。

安全告警位于固定 OMP npm 依赖链，而非已证明的 ObservationPack 运行故障：

- `@oh-my-pi/pi-mnemopi → onnxruntime-node → adm-zip`：[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)。
- `@huggingface/transformers → sharp`：[GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)、[GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)。

发现后暂停测试并询问用户，用户选择“保留风险，继续只读对比”。之后只处理合成文本，不处理 ZIP/图像；没有升级固定依赖，也没有把安全审计改记 PASS。此报告不等于安全验收通过。

### 对照方法与结果

使用用户现有 `openai-codex/gpt-6-astra`、`high` 配置和宿主管理的认证，未复制密钥。临时项目不含业务数据，使用既有 `tests/fixtures/model-observation.ts` 产生 700 行中文/emoji 文本，实际工具观察 **35,004 字节**。两组只切换 ObservationPack；均保留 `obs_recall`、原有插件和正常审批，所以这不是卸载扩展后的纯原生 OMP 基准。

保留阶段：一次大观察，随后三次 tick，各由独立用户提示触发；每组 8 条 assistant 消息、4 次工具调用。测试日志记录经过扩展的 Context 投影；费用和 token 来自真实 OMP `get_session_stats`，不是对文本字节数做 token 换算。

| 指标 | 关闭 | 开启 | 变化 |
|---|---:|---:|---:|
| 后期单次大观察投影字节 | 35,004 | 1,437 | −95.9% |
| 7 次投影累计观察字节 | 245,028 | 77,193 | −68.5% |
| 保留阶段累计 token，含 cache read | 222,941 | 165,807 | −25.6% |
| 保留阶段宿主标价估算 | 0.503746 | 0.450886 | −10.5% |
| 保留阶段 assistant 消息数 | 8 | 8 | 无变化 |
| 追加标记验证后的累计 token | 252,526 | 262,675 | **+4.0%** |
| 追加标记验证后的宿主标价估算 | 0.535276 | 0.733494 | **+37.0%** |

开启组前两次投影保留全文，第 3–7 次使用稳定 ID `obs_2cffaa0d75ca2ce45fb8c8d7`。会话日志仍含原始全文。实际 `obs_recall` 页偏移 `0 → 15872 → 31744 → 35004`，最后 `eof=true`；拼接结果和归档、会话原观察完全一致：

```text
SHA256 3eafc70efdb4a9d27a171e89510dd21f570f9199c72e4e0d105dec06648b48a9
中间标记 MIDDLE_MARKER_中间证据_7351
```

每页含头部不超过 16 KiB/400 行，归档文件 `0600`、对象目录 `0700`。重启与关闭打包后的新进程都重新调用三页工具恢复，不是仅凭模型记忆答对标记。

追加标记验证时，关闭组直接读取仍在上下文中的标记；开启组被明确要求完整回读三页以证明恢复。这是恢复压力场景，不是相同工具序列的性能基准。它说明恢复有额外调用/重放开销；只做了一对样本，没有控制供应商缓存状态，不能将标价估算当作实付账单，不能泛化成日常任务固定节省比例或延迟/成功率改善。

原生工具额外边界：默认 `read ...:raw` 只返回前 300 行，观察为 15,051 字节、占位 1,418 字节；该观察能精确恢复，但不包含第 351 行的中间标记。模型明确报告未找到，未编造。随后明确请求 `:1-700:raw`，实际观察为 35,055 字节（含宿主 footer），三页恢复全部已收到的文本并找回标记。**插件不能恢复宿主从未交给它的内容。**

### 四机制判定

| 机制 | 本轮结论 |
|---|---|
| ObservationPack | **PASS（已测范围）**：延迟占位、降低旧观察重放、精确分页恢复、同 session 重启与关闭后的恢复 |
| Action Fusion | **BLOCKED / 未实现**：配置 false，保留原生 edit/write；不能声称减少编辑后验证的调用 |
| Evidence-Preserving Reducer | **NOT_IMPLEMENTED / NOT_RUN**：没有辅助模型日志摘要能力 |
| Online Context Compact | **NOT_IMPLEMENTED / NOT_RUN**：没有该移植功能，不接管 OMP 原生 Compact |

因此“能否跑通”在上述 ObservationPack 场景中通过；“是否达到预期”是**减少旧观察重放已证实，普遍省钱及上游四项功能未证实/未实现**。

### 证据与仓库改动

- 持久、无凭证的结构化证据：[omp-comparison-2026-09-12.json](omp-comparison-2026-09-12.json)，含实际 session ID、Context 投影、usage、分页偏移、命令状态及风险决定。
- 原始 RPC/Context 日志与 session 归档位于私有临时目录 `/tmp/sol-omp-validation-xfnb8t50/`；可能被系统清理，不上传原始 session 或用户配置。归档始终位于宿主 session-derived `sessions/sol-omp/<session-id>/`，未自定义插件存储路径。
- 本轮只更新 `sol-omp/README.md`、本报告并新增上述 JSON 数据；未修改运行源码、测试源码、依赖锁或 `upstream.lock.json` 历史来源基线。已有未跟踪 `sol-omp/bun.lock` 保留，不提交。
- 临时 RPC 驱动/探针不进入项目源码，验证后移除；保留测试日志及 session 归档。测试没有向宿主注册永久 fixture，普通 OMP 不会加载测试工具。

---

**以下为本轮安装前的历史报告。** 其中 BLOCKED/NOT_RUN 和分支信息描述此前 CI/环境，不覆盖上面的本轮本地实测结果。

日期：2026-09-12。PR：[carter003/SoL-Pi #1](https://github.com/carter003/SoL-Pi/pull/1)，分支 `feat/sol-omp-mvp`；不合并 main，不修改原版 SoL-Pi 或 OMP core。

## 实际通过的远端验证

验证代码 commit：`414300470cb465563c030e712e20032f8d43c463`。
[GitHub Actions run 34673994872](https://github.com/carter003/SoL-Pi/actions/runs/34673994872) 的两个 job 均为 success；完整日志及生成的依赖锁保存在该 run 的 artifact，PR bot 评论提供有大小上限的日志副本。

| 执行 | 状态 | 证据/范围 |
|---|---|---|
| 安装 Bun 1.3.14、OMP npm 包 18.1.18 | PASS | 实际下载并安装 142 个包；未放开 2 个被 Bun 阻断的 postinstall |
| `bun run typecheck` / `tsc --noEmit` | PASS | 完整类型检查，保留 strict，不是只转译语法 |
| `bun test` | PASS | 36 pass / 0 fail，3 个测试文件 |
| `node --experimental-strip-types --test tests/*.test.ts` | PASS | Node 22.16.0 job；同一组单元测试 |
| `bun run smoke` | PASS | 两个真实 OMP 子进程，分别关闭/开启打包；检查扩展来源、obs_recall 注册、公共路径、配置加载和正常退出 |
| 真实模型 Context→占位→obs_recall | BLOCKED | 隔离环境无可用模型凭证；没有模型请求，未声称 E2E 通过 |
| 真实 OMP 同 session 重启恢复 | NOT_RUN | 只有单元层新实例/相同 session 路径恢复通过，不能替代真实重启 |
| Action Fusion 实现 | BLOCKED | 所选公开 API 缺少保留 bash 审批及 tool_call 拦截的跨工具派发，保持 false |
| Action Fusion 成功/失败/拒绝/取消运行时路径 | NOT_RUN | 没有实现，不把关闭功能冒充权限验证 |

CI 环境：GitHub Actions `ubuntu-22.04` Linux runner，Bun `1.3.14`，OMP `18.1.18`，TypeScript `5.8.3`。只有这些实际范围可称为通过，不能泛化到其他 OMP/Bun 版本、Windows、原生 Compact 或全部生命周期。

## 原始冒烟输出摘录

以下为 run 34673994872 的实际 `smoke.log` 内容；临时路径是该 runner 当次路径，不是用户安装路径。

```text
$ bun scripts/smoke.ts
{"status":"PASS","check":"OMP_LOAD","observationPack":false,"bun":"1.3.14","omp":"18.1.18","probe":{"status":"PASS","agentDir":"/tmp/sol-omp-real-host-TNFOPY/disabled/agent","sessionDir":"/tmp/sol-omp-real-host-TNFOPY/disabled/sessions","sessionId":"01a093f2-d54d-7000-b7a5-2d6fbbaf6776","tool":"obs_recall","source":{"path":"/home/runner/work/SoL-Pi/SoL-Pi/sol-omp/src/index.ts","source":"extension","scope":"temporary","origin":"top-level"},"hostVersion":"18.1.18"}}
{"status":"PASS","check":"OMP_LOAD","observationPack":true,"bun":"1.3.14","omp":"18.1.18","probe":{"status":"PASS","agentDir":"/tmp/sol-omp-real-host-TNFOPY/enabled/agent","sessionDir":"/tmp/sol-omp-real-host-TNFOPY/enabled/sessions","sessionId":"01a093f2-e2f8-7000-b040-fd29e617f0a8","tool":"obs_recall","source":{"path":"/home/runner/work/SoL-Pi/SoL-Pi/sol-omp/src/index.ts","source":"extension","scope":"temporary","origin":"top-level"},"hostVersion":"18.1.18"}}
SMOKE=PASS (real OMP loading/shutdown only; not MODEL_E2E)
```

## 本轮修复与历史失败

最初 run `34673484151`：依赖安装和 Bun/Node 单测通过，类型检查与冒烟失败。run `34673668517` 的日志确认 `assert.throws(fn, undefined, message)` 不符合类型声明；已改为明确的 Error predicate。没有关闭 strict 或跳过错误。

首次 RPC 冒烟没有指定模型，宿主自动选择只看具备认证的模型，因此在 session_start 前报 `No models available`。改为公开 `--model openai/gpt-5` 显式选择内置目录条目，只用于无提示词的加载检查；没有创建模拟模型、假密钥或绕过实际请求认证。

run `34673849647` 已通过类型检查和真实加载探针，但请求退出后仍等待 RPC 输入，最终超时，仍记录 FAIL。已依据宿主 `rpc-mode.ts` 的 EOF 清理路径，让客户端在收到完整探针结果后关闭 stdin；run `34673994872` 才完整通过。没有把超时 kill 视为正常退出。

## 本地环境与提交完整性

本地执行环境 Linux x86_64、内核 6.18.35、Node v22.16.0、npm 10.9.2。36 项单测在本地反复运行通过；Bun 未安装、GitHub/npm DNS 解析失败，本地依赖安装和 Bun 命令仍 BLOCKED。这不影响以上已实际执行并读取结果的远端 Actions 验证。

仓库写权限在本轮已恢复；通过 GitHub API 创建分支、提交和 Draft PR。源码/测试使用 Git blob/tree 校验核对本地与远端；用户上传计划 blob 为 `ab1f76eda97896892f0cd4802ffe62012732c375`，与原文件匹配。安装不改写实际用户配置或认证。

## 交付判定

这是**已通过真实宿主加载和最小本地/CI测试的实现候选版**，不是完整功能已完成的版本。真实模型链路、真实会话重启验证和 Action Fusion 仍未完成，PR 保持 Draft。README 已给出真实模型复现步骤。

上游源文件/许可证与本地适配关系见 `../UPSTREAM.md`、`../upstream.lock.json`。生成的 bun.lock 尚未提交，传递依赖未实现 frozen-lockfile 复现；不要把来源锁与依赖锁混为一谈。
