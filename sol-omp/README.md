# sol-omp — Evidence-Preserving Reducer + ObservationPack

在独立 `sol-omp/` 中将 NVIDIA SoL-Pi 的 Evidence-Preserving Reducer 与 ObservationPack 接入 OMP，不修改原版 SoL-Pi 或 OMP core。用户任务原文见 [实施计划](docs/implementation-plan-mvp.md)，实际结果见 [验证报告](docs/validation-report.md)。

**功能边界：** 已实现观察归档、延迟占位、分页恢复和严格用户级配置。2026-09-12 已在 Linux/WSL2、OMP 18.1.18 独立二进制、真实 `openai-codex/gpt-6-astra` 会话中验证打包、逐字节恢复、同 session 进程重启及关闭打包后恢复旧引用。Evidence-Preserving Reducer 已在同一宿主通过真实合成日志、辅助模型、receipt 校验和后续 Context 投影验证。Action Fusion 保持关闭；Online Context Compact 未移植。这不等于上游四项机制全部通过。

## 固定环境

- SoL-Pi 源码：`d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`。
- OMP：本地 npm 包及用户实际独立二进制均为 `18.1.18`；npm 基线源码 tag 对应 `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。
- Bun：`1.3.14`。CI 使用 GitHub Actions `ubuntu-22.04` Linux runner；另在 Node `22.16.0` 运行 36 项单元测试。
- 支持声明仅限验证报告中实际通过的范围，不泛称支持 `>=18.x` 或 Windows。

`upstream.lock.json` 保留来源、适配文件校验值和分阶段验证记录，不是依赖解析锁。`bun.lock` 是已提交的依赖锁；使用下述 frozen 命令复现依赖。当前安装和实测数据见 [验证报告](docs/validation-report.md)。

## 安装与检查

```bash
cd SoL-Pi/sol-omp
bun --version             # 本次验证版本为 1.3.14
bun install --frozen-lockfile --ignore-scripts  # 需要已有 bun.lock
bun run typecheck
bun test
bun run smoke
```

本次 `bun audit --audit-level=high` **FAIL**：固定 OMP 依赖链中 `adm-zip`、`sharp` 共 3 项 high 告警。用户明确选择保留风险，仅继续合成文本的只读测试；没有升级依赖或宣称漏洞已修复。类型检查/运行测试通过不代替安全审计通过。

检查失败时保留真实输出，不把未运行阶段标记为 PASS。只有 Node 的环境可运行下面的**单元测试**，但它不代替完整类型检查或真实宿主验证：

```bash
node --experimental-strip-types --test tests/*.test.ts
```

`smoke` 从本目录已安装包的 `package.json#bin.omp` 获取真实 CLI，严格检查 OMP/Bun 版本；不使用 PATH 中另一个 OMP。它启动隔离 RPC 会话，检查扩展来源、工具注册、配置路径和 session 接口，再由客户端关闭 stdin，让 OMP 正常清理退出。分别测试关闭/开启打包和 manifest 目录/显式 TS 入口。没有探针、非零退出或超时均失败。

测试只在临时 HOME、agent 和项目中写配置，不继承模型密钥。通过 `--model openai/gpt-5` 选择宿主内置目录条目以避免无凭证的自动默认选择；**不发送提示词、不注入假密钥、不调用模型**。测试里的 `--no-extensions` 仅隔离测试环境，正常使用时不要据此关闭已有权限/拦截扩展。

## 使用和配置

正常使用继续由 OMP 管理模型和认证。对于已验证的 OMP 18.1.18，可按选定范围持久链接本地源码；本次用户选择了 user 范围：

```bash
omp plugin link /absolute/path/to/SoL-Pi/sol-omp --scope user
omp plugin list --json
```

链接后新启动的 `omp` 自动加载，原有会话须重启；不要再重复传扩展入口。保留源码目录，移动目录会使链接失效。只做临时加载、不建立持久链接时：

```bash
SOL_OMP_ROOT=/absolute/path/to/SoL-Pi/sol-omp
bun "$SOL_OMP_ROOT/node_modules/.bin/omp" \
  --extension "$SOL_OMP_ROOT/src/index.ts"
```

使用非默认 profile 时保留相应 `--profile` 参数。`session_start` 在交互模式通过公开 `ctx.ui.notify` 显示加载信息和实际配置路径，不直接写 stderr，以免打断输入区域；无 UI 的 RPC/print 模式仍将诊断写入 stderr。启用 EPR 时，交互模式另显示 warning 级通知，保留辅助路由、诊断日志外发、额外供应商用量及 `session_stop` 运行时机的提醒；无 UI 时同样保留该提醒。加载信息示例：

```text
[sol-omp] loaded observationPack=false actionFusion=false config=<实际路径>/sol-omp.json
```

用户在该位置手动创建：

```json
{
  "version": 1,
  "observationPack": true,
  "actionFusion": false
}
```

路径来自公开 `api.pi.getAgentDir()`，尊重当前 profile/宿主目录设置，不硬编码 home、不读取项目级配置。插件不会自动创建或改写用户配置。配置缺失时功能开关默认 false；已有文件必须有 `version: 1`，未知字段、非布尔值、无效 JSON 均报错。Reducer 开启还必须显式提供非空 provider/model；可选超时只能为 1–90000 的整数毫秒。改配置后重启 OMP，本次不做热更新。

同时关闭 ObservationPack 与 Reducer 后不注册 Context hook，但仍保留只读 `obs_recall` 以恢复已有引用。不覆盖 edit/write。`actionFusion: true` 会在注册任何工具和事件前明确报错；改回 false 后才能加载本阶段插件。

## 观察规则和存储

超过 **10 KiB** 的成功、非空、纯文本工具结果参与；错误、混合图像、小结果和 Reducer receipt 跳过。先成功归档，前两次 Context 投影保留全文，随后替换稳定占位。只改模型 Context 副本，不覆盖原会话消息。保存或校验失败保留原文。

“原文”是 OMP 实际交给插件的工具观察，多个 text block 按上游规则用换行拼接；不等于源文件全文或工具截断前的输出，不能恢复从未收到的数据。发送次数沿用上游投影计数和后续 assistant 消息恢复规则，不是模型请求计费遥测。

```text
<ctx.sessionManager.getSessionDir()>/sol-omp/<session-id>/
  observation-pack/objects/obs_<24位十六进制>.txt
```

每次调用解析当前 session，不缓存首个 session 路径；恢复工具只接受当前 session 的 observation id，不接受任意路径。默认保留归档，关闭/卸载不删除。新文件为 `0600`、对象目录 `0700`；日志可能含代码或敏感内容，勿公开归档。符号链接检查不是对恶意同用户进程的原子安全沙箱。

使用占位中真实 id 调用 `obs_recall`，从 `offset: 0` 开始，跟随返回的 `next_offset`，直到 `eof: true`。偏移为 UTF-8 字节，不是字符。每页含头部最多 16 KiB/400 行；非法 id、偏移或 UTF-8 字符中间偏移会拒绝。

## 真实模型验证与对照

本次已执行下面的功能链路，详见 [实测报告](docs/validation-report.md) 与 [结构化数据](docs/omp-comparison-2026-09-12.json)。复现时在已有真实模型配置的 OMP profile 中开启打包，追加测试工具，保持正常权限设置：

```bash
omp --extension "$SOL_OMP_ROOT/tests/fixtures/model-observation.ts"
```

提示模型：

```text
先调用 sol_omp_test_observation，再依次调用三次 sol_omp_test_tick。
必须分成独立回合，不要并行。旧观察变成 obs_ 引用后，使用 obs_recall，
从 offset=0 逐页跟随 next_offset，直到读取到中间标记。
报告标记、真实 observation id 和该页偏移；不要仅凭初始记忆回答。
不要编辑文件，不要执行 shell 命令。
```

必须保留实际 `SOL_OMP_MODEL_CONTEXT` 中大于阈值的观察、早期全文/后期占位、真实 recall 调用及分页结果，以及会话原文未覆盖的证据。模型答对标记不等于验证通过。随后退出并恢复同一 session，验证同 id 能读取；关闭打包后重启，验证不再产生新占位而旧引用仍能恢复。测试 fixture 只提供证据，不自动宣告 MODEL_E2E=PASS。

对照只切换 ObservationPack，保留 `obs_recall` 工具及原有权限/插件；这不是卸载扩展的纯原生 OMP 大规模基准。同样 8 次模型响应中，观察重放累计字节减少 68.5%，宿主报告累计 token 减少 25.6%。但追加强制完整回读后，该轮累计 token 增加 4.0%、宿主标价估算增加 37.0%；不是实付账单或普遍省钱承诺。适合旧观察较少再被完整读取的场景，按需分页，勿为了“验证使用”在每次正常任务中完整回读。

## Evidence-Preserving Reducer：配置、外发与运行边界

本轮用户确认的路由为 **`opencode-go/glm-5.3-flash`**。当前用户级 `/home/carter003/.omp/agent/sol-omp.json` 已启用；普通新 OMP 主会话自动加载，已有进程须重启。只对合成日志做过验证，未发送业务日志。配置示例：

```json
{
  "version": 1,
  "observationPack": true,
  "actionFusion": false,
  "evidencePreservingReducer": true,
  "evidencePreservingReducerProvider": "opencode-go",
  "evidencePreservingReducerModel": "glm-5.3-flash"
}
```

关闭时只将 `evidencePreservingReducer` 改为 `false` 并重启；保留模型字段无妨。不要调整原生 Code Mode、主模型或 `actionFusion` 来代替这个开关。配置超时默认 90000 ms，可用 `evidencePreservingReducerTimeoutMs` 调小。生命周期补修后，整个 settle 队列另受 `min(25000 ms, 配置超时)` 的共享预算约束，为 OMP 18.1.18 的 30 秒 handler 预算预留取消清理时间；预算耗尽保留原文、不接受迟到 receipt、不重试。该余量不保证不响应取消的供应商或卡死 I/O 能按时退出。启用开关不是“合成数据沙箱”：将来符合条件的业务诊断日志也会发送到该路由；若仍仅允许合成数据，进入业务工作前先关闭。

**外发和费用：** 辅助请求包含日志全文、命令 hash、来源 hash、大小、行数及失败状态，不带完整会话或明文命令。日志本身可能含代码或凭证；沿用上游的疑似敏感内容过滤只是保守启发式，不保证检出全部秘密。凭证只由 OMP 公开认证 API 在请求中解析，不复制认证文件、不持久化密钥、不用私有会话接口。当前宿主目录标价为输入 $0.075、输出 $0.25、cache read $0.015／百万 token；模型另标注“2x usage”，订阅额度与美元估算不同。不是免费能力或账单承诺。辅助调用不自动进入前台 `get_session_stats`；须另加 stderr 的 `SOL_OMP_EPR` response 中 attempts、usage、cost 和 durationMs。`usageComplete=false` 的错误/取消请求不能按零成本结算。

**时序：** OMP 18.1.18 的 `tool_result` / `context` 没有公开取消 signal，因此这里只收集候选；在公开 `session_stop.signal` 下依次等待辅助请求，不创建后台任务或自动续跑。首轮主模型仍读全文，receipt 从后续 Context 开始使用；不能减少首次读取或同一尚未结束长任务内的读取。宿主不向子代理发出该 settle hook，子代理不承诺 reducer 调用；没 receipt 就保留原文。

**候选：** 沿用锁定上游的诊断命令正则、至少 4096 字节、最多 600000 字符、最多 2048 输出 token、12 条逐字引用、每条最多 600 字符。只处理实际观察到的纯文本 native bash 结果；支持 native eval 内 bash，但必须能唯一关联外层调用，并在外层完整观察里找到原文的唯一精确文本或 JSON 转义形式。并发父调用歧义、被 eval 截断/重新格式化的结果均保留，不把 native eval 当成 `then_run`。

**失败与组合：** 不返回任何 `tool_result` 改写。除事件布尔值外，还检查实际 `exitCode`、details 错误/超时状态和明确的宿主失败尾注；矛盾的成功状态保守回退。已确认失败日志可以形成 `status=failure` receipt，原消息错误字段保持不变。模型失败、超时、取消、可疑内容、归档/引用/状态校验失败都保留原文；ObservationPack 不得再次打包这些回退或已验证 receipt。重启后无缓存 receipt 的 bash/eval 也保守保留全文，其他观察仍按 ObservationPack 规则处理。

**存储与恢复：**

```text
<ctx.sessionManager.getSessionDir()>/sol-omp/<session-id>/
  evidence-preserving-reducer/objects/<hash前2位>/<完整SHA256>.txt
```

归档是 OMP 实际交给扩展的完整观察文本；不是工具截断前的全部 stdout。此适配不读取 Pi 临时文件或猜测 OMP artifact 私有路径。文件 `0600`，目录 `0700`；新文件 fsync 后才使用，已有对象逐字节/hash 校验，Context 使用前也复核归档。原会话不改写；关闭、重启或卸载不删除归档。按 receipt 的 `source_artifact` 用原生 `read` 加明确行范围读取；已验证退出后恢复同一 session 能完整读回。引用真实不代表摘要完整，证据分类也不是语义证明；诊断、修复和最终通过判定仍由主模型负责。

**本轮收益：** 在 ObservationPack 已开启的三对短任务中，前台 token −5.55%，但加上 3 次 reducer 后总 token **+2.59%**、标价估算 **+29.29%**、累计耗时 **+8.91%**。累计观察重放字节 −44.68%。这组样本没有总体省钱或提速收益；适合性取决于后续重放次数、缓存与回读需求。完整调用/故障/费用见 [验证报告](docs/validation-report.md) 和 [本轮结构化证据](docs/epr-comparison-2026-09-12.json)。

复现：在没有业务文件的临时 npm 项目中生成合成诊断输出，执行 `npm test`，随后发送两个不调用工具的证据复核问题；两组仅切换 reducer。数据文件保留完整测试脚本及三个相同提示词。Code Mode 应 `display(result.text)`；直接打印巨大的结果对象可能先被宿主截断，适配会拒绝用完整日志的 receipt 替换无法精确对应的投影。

## OMP 原生 eval 顺序融合（独立替代方案）

用户在确认扩展接口阻塞后选择此方案。**它不是 sol-omp Action Fusion，没有 `then_run`，`sol-omp.json` 中 `actionFusion` 仍须为 false。**

2026-09-12 在当前用户默认 profile 的 OMP 18.1.18 上通过宿主 CLI 配置：

```bash
omp config set providers.openai-codex.codeMode on
omp config set bash.autoBackground.enabled false
```

`eval.autoBackground.enabled` 原本为 false，保持不变。关闭 bash 自动后台化是为了让有限时的验证在该 eval 内返回最终结果；`async:false` 本身不足以禁止宿主自动后台化。长命令会等待结束或超时，显式后台任务仍可使用。原有 `tools.approvalMode=yolo`、`tools.approval={}`、模型和认证均未改动。新会话可直接使用；已有会话建议重启。

Code Mode 的宿主提示会鼓励把已知操作合入一个单元，但不会强制每次编辑自动融合。日常任务可明确要求：

> 在一个 JS eval 内顺序 await 原生 tool.read → tool.edit → tool.bash。使用 read 返回的真实快照生成编辑。检查每一步返回的 hasError；错误、拒绝或取消后停止依赖步骤，不重试编辑、不回滚已成功的编辑。不要用 Promise.all 并行编辑与验证，不要用原始 fs/Bun.$ 替代原生工具。

桥接工具既可能抛异常，也可能返回 `{hasError:true}`；单纯 `try/catch` 不够。如果显式选择后台验证，拿到 `details.async.state="running"` 只表示已启动，不能报告验证通过。此方案不提供 sol-omp 文件队列或执行命令前的外部改动检查。

真实模型测试通过：单元内原生 edit/write 和验证、编辑失败停止 bash、命令退出 7 保留编辑、独立 bash 审批通过/拒绝、deny 策略、扩展拦截、批准前取消、运行中取消和超时。原生 `tool.*` 逐次经过当前会话的权限/拦截；这不是对原始 JS I/O 的权限保证。

最终同步配置下三对受控样本：模型可见工具调用每任务 **2 → 1**，模型响应 **3 → 2**，累计 token **−33.5%**，实际 read/edit/bash 调用仍 **3 → 3**。缓存状态不同，三对合计宿主标价估算反而 **+12.7%**；不承诺普遍省钱。详见 [本轮报告](docs/validation-report.md) 和 [原生融合数据](docs/native-fusion-comparison-2026-09-12.json)。

恢复本轮修改前的两项 OMP 设置：

```bash
omp config set providers.openai-codex.codeMode off
omp config set bash.autoBackground.enabled true
```

## 已知限制

[Action Fusion 阻塞](docs/action-fusion-blocker.md)：同名 `ctx.invokeTool()` 不能从 edit 调用 bash，直接 `api.exec()` 不经过 bash 审批和 tool_call 拦截；适配包当前没有 then_run、队列或融合执行实现。上面的原生 eval 方案由 OMP 自己执行，不解除该扩展接口阻塞，也不能计为 sol-omp Action Fusion 验收通过。

不接管 Compact，不自动中断/续跑/清理，不做大规模性能基准、上游自动同步、Marketplace 或 npm 发布。本次仅完成单一合成文本的开关对照及实际 OMP 生命周期验证；分支导航、Compact 组合、跨机器迁移和 Windows 原生环境未验证。源码映射和适配理由见 [UPSTREAM.md](UPSTREAM.md)。