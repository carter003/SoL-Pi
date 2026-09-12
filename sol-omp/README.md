# sol-omp — ObservationPack MVP

在独立 `sol-omp/` 中将 NVIDIA SoL-Pi 的 ObservationPack 接入 OMP，不修改原版 SoL-Pi 或 OMP core。用户任务原文见 [实施计划](docs/implementation-plan-mvp.md)，实际结果见 [验证报告](docs/validation-report.md)。

**功能边界：** 已实现观察归档、延迟占位、分页恢复和严格用户级配置。Action Fusion 尚未实现，保持关闭；Reducer 与 Online Context Compact 不在本次范围内。真实模型侧链路与真实同 session 重启恢复仍待验证，不能把单元测试和加载检查说成完整 E2E。

## 固定环境

- SoL-Pi 源码：`d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`。
- OMP：本地 npm 包 `@oh-my-pi/pi-coding-agent@18.1.18`；源码 tag 对应 `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。
- Bun：`1.3.14`。CI 使用 GitHub Actions `ubuntu-22.04` Linux runner；另在 Node `22.16.0` 运行 36 项单元测试。
- 支持声明仅限验证报告中实际通过的范围，不泛称支持 `>=18.x` 或 Windows。

`upstream.lock.json` 是来源和验证基线，不是依赖解析锁。本次 CI 实际执行 `bun install`，生成的 `bun.lock` 保存在 Actions artifact，尚未提交仓库；传递依赖还未达到 frozen-lockfile 复现。再次安装后保留生成的锁并复跑验证，不手工编造依赖锁。

## 安装与检查

```bash
cd SoL-Pi/sol-omp
bun --version             # 本次验证版本为 1.3.14
bun install
bun run typecheck
bun test
bun run smoke
```

检查失败时保留真实输出，不把未运行阶段标记为 PASS。只有 Node 的环境可运行下面的**单元测试**，但它不代替完整类型检查或真实宿主验证：

```bash
node --experimental-strip-types --test tests/*.test.ts
```

`smoke` 从本目录已安装包的 `package.json#bin.omp` 获取真实 CLI，严格检查 OMP/Bun 版本；不使用 PATH 中另一个 OMP。它启动隔离 RPC 会话，检查扩展来源、工具注册、配置路径和 session 接口，再由客户端关闭 stdin，让 OMP 正常清理退出。分别测试关闭/开启打包和 manifest 目录/显式 TS 入口。没有探针、非零退出或超时均失败。

测试只在临时 HOME、agent 和项目中写配置，不继承模型密钥。通过 `--model openai/gpt-5` 选择宿主内置目录条目以避免无凭证的自动默认选择；**不发送提示词、不注入假密钥、不调用模型**。测试里的 `--no-extensions` 仅隔离测试环境，正常使用时不要据此关闭已有权限/拦截扩展。

## 使用和配置

正常使用继续由 OMP 管理模型和认证。安装后，在目标项目目录显式加载：

```bash
SOL_OMP_ROOT=/absolute/path/to/SoL-Pi/sol-omp
bun "$SOL_OMP_ROOT/node_modules/.bin/omp" \
  --extension "$SOL_OMP_ROOT/src/index.ts"
```

使用非默认 profile 时保留相应 `--profile` 参数。session_start 日志将打印实际配置路径：

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

路径来自公开 `api.pi.getAgentDir()`，尊重当前 profile/宿主目录设置，不硬编码 home、不读取项目级配置。插件不会自动创建或改写用户配置。配置缺失时开关默认 false；已有文件必须有 `version: 1`，未知字段、非布尔值、无效 JSON 均报错。改配置后重启 OMP，本次不做热更新。

关闭打包后不注册 Context hook，但仍保留只读 `obs_recall` 以恢复已有引用。不覆盖 edit/write。`actionFusion: true` 会在注册任何工具和事件前明确报错；改回 false 后才能加载本阶段插件。

## 观察规则和存储

超过 **10 KiB** 的成功、非空、纯文本工具结果参与；错误、混合图像、小结果和 Reducer receipt 跳过。先成功归档，前两次 Context 投影保留全文，随后替换稳定占位。只改模型 Context 副本，不覆盖原会话消息。保存或校验失败保留原文。

“原文”是 OMP 实际交给插件的工具观察，多个 text block 按上游规则用换行拼接；不等于源文件全文或工具截断前的输出，不能恢复从未收到的数据。发送次数沿用上游投影计数和后续 assistant 消息恢复规则，不是模型请求计费遥测。

```text
<ctx.sessionManager.getSessionDir()>/sol-omp/<session-id>/
  observation-pack/objects/obs_<24位十六进制>.txt
```

每次调用解析当前 session，不缓存首个 session 路径；恢复工具只接受当前 session 的 observation id，不接受任意路径。默认保留归档，关闭/卸载不删除。新文件为 `0600`、对象目录 `0700`；日志可能含代码或敏感内容，勿公开归档。符号链接检查不是对恶意同用户进程的原子安全沙箱。

使用占位中真实 id 调用 `obs_recall`，从 `offset: 0` 开始，跟随返回的 `next_offset`，直到 `eof: true`。偏移为 UTF-8 字节，不是字符。每页含头部最多 16 KiB/400 行；非法 id、偏移或 UTF-8 字符中间偏移会拒绝。

## 真实模型验证（未执行）

先在已有真实模型配置的 OMP profile 中开启打包，追加测试工具，保持正常权限设置：

```bash
bun "$SOL_OMP_ROOT/node_modules/.bin/omp" \
  --extension "$SOL_OMP_ROOT/src/index.ts" \
  --extension "$SOL_OMP_ROOT/tests/fixtures/model-observation.ts"
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

## 已知限制

[Action Fusion 阻塞](docs/action-fusion-blocker.md)：同名 `ctx.invokeTool()` 不能从 edit 调用 bash，直接 `api.exec()` 不经过 bash 审批和 tool_call 拦截；当前没有 then_run、队列或融合运行时路径，不能把“没有执行命令”冒充权限拒绝验收。

不接管 Compact，不自动中断/续跑/清理，不做原生 OMP 性能对照、上游自动同步、Marketplace 或 npm 发布。分支导航、Compact 组合、跨机器迁移和 Windows 未验证。源码映射和适配理由见 [UPSTREAM.md](UPSTREAM.md)。
