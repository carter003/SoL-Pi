# 来源与本地适配记录

## 基线

- fork：`carter003/SoL-Pi`，读取到的 main：`d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`。
- 上游项目：NVIDIA `NVlabs/SoL-Pi`；本次选取的是 fork 中该固定 commit 的源文件，不自动追踪 main。
- OMP：候选 npm 包 `@oh-my-pi/pi-coding-agent@18.1.18`；release tag 指向 `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。源码接口已核对，固定 npm 包已在 GitHub Actions 安装并执行；各项通过/阻塞范围以 `docs/validation-report.md` 为准，不泛称全部兼容。
- 用户任务原文：`docs/implementation-plan-mvp.md`，按上传文件原样保留。

未克隆完整仓库：本地容器 GitHub DNS 解析失败，GitHub 连接和远端 Actions 可用。本交付是基于已读取的固定源文件创建的新增 `sol-omp/` 目录，补丁仅新增这些文件，不改动 fork 中原版 SoL-Pi 文件。

## 源码映射

| 上游路径（相对 src/sol-pi） | 本地路径 | 处理 |
|---|---|---|
| `extensions/observation-pack/observation.ts` | `src/upstream/sol-pi/observation-pack/observation.ts` | 复制核心实现；原文件 8730 字节，Git blob SHA 经本地计算匹配 `42a08c6b3d5a4640a003c4693dad43873bb305f7` |
| `extensions/observation-pack/index.ts` | `src/omp/observation-pack.ts` | 按真实 OMP API 改写注册、投影与恢复编排；保留来源版权 |
| `runtime-paths.ts` | `src/omp/observation-pack.ts` 的 runtimeRoot | 同样使用宿主 session 目录与 id，名称空间由 sol-pi 改为 sol-omp |
| 仓库根 `LICENSE` | `LICENSE` | 原样保留 NVIDIA MIT 许可 |

每项源文件 blob 和本地 SHA-256 见 `upstream.lock.json`。`index.ts` 和 `runtime-paths.ts` 是有记录的派生代码，不宣称字节完全相同。

## 观察算法文件的改动

1. 将原版 Pi 的类型导入替换为 OMP 公开 ContextEvent 类型，并从其 messages 推导 AgentMessage / ToolResultMessage / TextContent。均为 type-only；避免安装第二套 agent/AI runtime，也避免直接依赖宿主传递依赖的包布局。
2. 新写归档后调用 FileHandle.sync，再允许生成占位；保留原来的排他创建、O_NOFOLLOW、既有文件大小/hash 校验和私有权限。
3. 分页入口增加安全整数/非负 offset、有效页长校验，拒绝 UTF-8 continuation byte 中间偏移，并对非空对象读取零字节的变化场景报错。
4. ID、hash、10 KiB 阈值、两次全文、1024 字节完整行首尾摘录、receipt 识别、字节分页规则保持上游语义。多个 text block 仍用换行拼接。

## OMP 编排层的改动

- 使用 `api.typebox.Type` 与 `api.pi.getAgentDir()` 注入能力，不引入原版 Pi、通用 Runtime Contract 或私有工具执行器。
- 用户级严格配置；缺失默认关闭；没有项目级配置、配置热更新或安装时配置写入。
- `obs_recall` 明确标记 `approval: read`、`loadMode: essential`。关闭打包时保留该恢复工具，不注册 Context hook。
- 每次事件/调用解析当前 session；根路径异常也落入 fail-open，不让目录异常丢弃本次上下文。
- 投影使用新数组，仅为占位创建新消息；保留工具调用标识和其他字段。相同 message 在一次投影中重复出现时只计一次发送。
- 复用上游基于后续 assistant 消息的重启计数重建，没有新建持久化计数数据库。
- 增加对宿主存储锚点以下已存在目录符号链接的拒绝。此检查不是对同用户恶意进程的原子安全沙箱，不承诺阻止全部文件系统竞态。
- 按 MVP 省略 ledger、TUI 节省量展示与性能收益估算，避免可选遥测失败影响核心链路。
- 不订阅或接管 Compact；不处理用户和 assistant 内容的压缩；不后台清理归档。

## 有意不复制的模块

Action Fusion 的受保护命令派发被 OMP 接口阻塞，未复制其 file-queue / then-run 形成不能运行的空实现。Online Context Compact 未移植。Evidence-Preserving Reducer 的新增来源和适配见下节。

`src/omp/action-fusion.ts` 只有明确报错的开关守卫。原因和固定源码链接见 `docs/action-fusion-blocker.md`。

## 测试分层

36 项测试在 Node v22.16.0 和 Bun v1.3.14 真正执行；完整 TypeScript 检查也在远端运行。fake-API 仅验证注册与回调编排，不能证明 OMP 加载或权限链。独立 `scripts/smoke.ts` 必须启动精确本地 OMP 包；测试扩展仅观测宿主、请求正常退出，不伪造宿主。冒烟通过宿主公开的显式模型选择绕过自动默认选择的凭证筛选，不发送提示词或注入假密钥；客户端在收到真实探针结果后关闭 RPC stdin，走宿主正常 EOF 清理。模型测试 fixture 不注册模拟模型/代理，不接触认证，也不自动宣告 MODEL_E2E=PASS。

## 后续同步

保留 fork 的上游 Git 历史。后续先取所选文件到候选目录，比较上述差异，更新来源与校验值，再执行固定版本类型检查、测试和真实 smoke。不要直接覆盖本地已适配源码，也不要在验证前提升支持版本或推送主分支。
## Evidence-Preserving Reducer 适配（2026-09-12）

继续使用同一个锁定 commit `d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`，未移动上游基线；各文件 Git blob 和当前本地 SHA256 写入 `upstream.lock.json`。根目录原版 SoL-Pi、OMP core/node_modules 均未改动，NVIDIA 版权和 MIT 许可保留。

| 上游 EPR 文件 | 本地文件 | 差异 |
|---|---|---|
| `config.ts` | `src/upstream/sol-pi/evidence-preserving-reducer/config.ts` | 字节不变，复用诊断/敏感正则、hash、阈值、schema、引用和输出上限；适配配置开启时强制显式路由，不暗用上游默认 |
| `archive.ts` | 同目录 `archive.ts` | 保留 hash 分片、排他创建及旧对象完整性检查；补齐逐层目录/文件 symlink 拒绝、O_NOFOLLOW、权限、fsync、原始字节和 UTF-8 校验；删除无意义 archiveRoot 包装 |
| `receipt.ts` | 同目录 `receipt.ts` | 引用、来源 hash、状态、数量/长度校验算法不变；替换 provider type-only import；去掉“lossless”误导措辞，显式声明引用/分类不保证完整性，恢复说明改用 OMP read |
| `candidate.ts` | 同目录 `candidate.ts` | 纯文本 native bash、沿用诊断命令判断；不读取 Pi 临时日志，不猜 OMP 私有 artifact 路径，不实现 then_run；返回 command/body，不改写结果 |
| `provider.ts` | `src/omp/reducer-provider.ts` | 公开 ModelRegistry.find/getApiKey 与 pi-ai.completeSimple；真正父 signal + deadline；统计实际 completed attempts、usage/cost/duration，错误输出脱敏 |
| `index.ts` | `src/omp/evidence-preserving-reducer.ts` | 收集 tool_result；在公开 session_stop 下等待 reducer；缓存验证 receipt，仅修改随后 Context 投影；无结果改写、自动续跑、私有 session、后台 jobs |

### 与原上游及实施计划第 9 节的明确差异

1. **取消优先于首次读取节省。** OMP 18.1.18 `ExtensionContext`、`ToolResultEvent`、`ContextEvent` 没有公开 signal。真实宿主探针也确认 `contextHasSignal=false`。不用类型断言伪造 signal，不包装原生 bash 去丢失其审批元数据。使用 `shared-events.ts:97-106` 的 `session_stop.signal`；`agent-session.ts:4110-4129` 将公开事件接到 post-prompt 取消控制器。因此首轮全文不变，只节省后续 Context 重放。宿主子代理不发此 hook，保持原文。
2. **认证不绕路。** registry 没有 complete；公开 `getApiKey(model, sessionId, {signal})` 以请求内回调转交给 `completeSimple`。没有读取/复制认证文件或新存储密钥。未直接采用 `registry.resolver`：锁定版 `config/api-key-resolver.ts:53-55` 初次认证未传 signal；强制刷新分支才传递。没有复制其认证轮换策略，也没有适配层重试。模型对象保持宿主解析的 URL/headers，`systemPrompt` 适配为 OMP 的 string[]。
3. **依赖明确。** 将已经安装并锁定的 `@oh-my-pi/pi-ai@18.1.18` 声明为直接 peer/dev 依赖；仅补既有 `bun.lock` 的根声明，不升级依赖、不安装第二套 Pi。OMP loader 的 canonical bare pi-ai import shim 连接宿主运行时；真实选定路由的完成链路证明了正常调用可用，不泛化为任意自定义 API 覆盖都有效。
4. **错误状态不依赖事件顶层。** 补查 details.exitCode、isError/hasError、timedOut 和明确失败尾注；矛盾成功诊断保留原文。工具结果事件订阅返回 void，从不写回 content/details/isError。失败 receipt 仍为 failure，Context 消息其他协议字段原样保留。
5. **native eval 不是 Action Fusion。** 会话内依据事件关联唯一外层 eval，只替换同一已观察结果中的唯一精确原文（或 JSON 转义字符串）。父调用歧义、重复正文、截断或改格式都拒绝投影。不支持从任意 eval 输出猜回日志，也不生成 then_run。
6. **组合 fail-open。** EPR 先投影，ObservationPack 明确跳过 receipt 和 EPR 原文回退；无可验证缓存的 bash/eval（包括重启）也保守保留。原 OP 模块的接口增加这个明确保留集合，其他观察逻辑不变。每次投影复核归档，工具调用/内容变动不复用旧 receipt。
7. **去重范围。** 内存状态按 session-derived root、工具调用 ID、完整内容 hash。失败、取消也记录 attempted；重复 settle/context 不重新花费。无持久摘要数据库，重启不重新处理历史消息；归档和原会话保留。
8. **遥测边界。** `SOL_OMP_EPR` 记录 request/response/verified/fallback、hash、实际 completed-attempt usage/cost/duration。错误/取消响应的账单完整性为 false，不能把零使用字段当免费。没有复制上游 TUI、journal session entries 或节省量估算；receipt 的历史标记/schema 保留，与 ObservationPack 识别兼容。

单元测试、真实模型、故障注入与首次失败严格分层见验证报告。无效引用最终用“真实模型返回后、校验前”边界注入验证；临时注入入口/探针已移除，不向永久运行源码留下假模型或测试路由。三个 high 依赖告警仍未修复。

## EPR 生命周期补修（经用户授权）

整个 settle 队列增加 min(25000ms, 配置超时) 的共享预算，给 OMP 18.1.18 默认 30 秒 handler 留 5 秒取消清理余量；预算覆盖归档与全部候选，父取消转发并等待辅助工作结束，预算耗尽/迟到 receipt 原文回退且不重试。与原版/初版每请求 90 秒不同；配置字段仍兼容且用户配置未改。真实 runner 的三候选探针在 25.032 秒返回、无活动辅助工作或宿主超时告警；模型未调用。非协作取消、卡死 I/O 不作硬截止保证。详细前后证据见 docs/epr-root-cause-analysis-2026-09-12.md 第12节。

### Artifact 恢复等待与取消补修

observe 仅同步收集，不执行 Artifact I/O；完整源恢复统一进入 session_stop 的 settle 预算。候选在任何恢复 await 前标记 attempted；共享 signal/deadline 在路径查询、目录枚举及读取前后检查，readFile 绑定 signal。取消/到期后不启动回退 I/O 或后续候选，不接受迟到源，也不重复恢复或花费。getArtifactPath 与目录枚举没有取消参数，已经开始的操作须等待结束，不通过 Promise.race 遗留后台工作。恢复后的秘密、大小、状态准入与不可用原文回退不变。

四项新回归及最终 68 项完整回归通过，tsc 与真实 OMP 加载/关闭烟测通过；未发送真实模型请求。此次真实宿主烟测仅覆盖加载/关闭，注册恢复路径另用无模型内存烟测验证。历史第15–16节的“双重恢复”说明由此更新；详细证据及非协作取消边界见根因分析第17节。
