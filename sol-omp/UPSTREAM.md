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

Action Fusion 的受保护命令派发被 OMP 接口阻塞，未复制其 file-queue / then-run 形成不能运行的空实现。Evidence-Preserving Reducer 与 Online Context Compact 不在本次代码中。

`src/omp/action-fusion.ts` 只有明确报错的开关守卫。原因和固定源码链接见 `docs/action-fusion-blocker.md`。

## 测试分层

36 项测试在 Node v22.16.0 和 Bun v1.3.14 真正执行；完整 TypeScript 检查也在远端运行。fake-API 仅验证注册与回调编排，不能证明 OMP 加载或权限链。独立 `scripts/smoke.ts` 必须启动精确本地 OMP 包；测试扩展仅观测宿主、请求正常退出，不伪造宿主。冒烟通过宿主公开的显式模型选择绕过自动默认选择的凭证筛选，不发送提示词或注入假密钥；客户端在收到真实探针结果后关闭 RPC stdin，走宿主正常 EOF 清理。模型测试 fixture 不注册模拟模型/代理，不接触认证，也不自动宣告 MODEL_E2E=PASS。

## 后续同步

保留 fork 的上游 Git 历史。后续先取所选文件到候选目录，比较上述差异，更新来源与校验值，再执行固定版本类型检查、测试和真实 smoke。不要直接覆盖本地已适配源码，也不要在验证前提升支持版本或推送主分支。
