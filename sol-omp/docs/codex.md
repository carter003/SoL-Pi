# Codex adapter：Observation Pack + EPR

该适配不使用 MCP、不替代 Codex 原生工具，也不修改 Codex 源码。Codex 继续执行原生 `exec_command`/shell，并保留其 sandbox、permission、cwd 和进程行为；SoL 只通过同步 `PostToolUse` 命令 Hook 处理模型可见输出。

## 行为

```text
模型可见输出 < 4 KiB  → Hook stdout 为空 → Codex 原样处理
模型可见输出 ≥ 4 KiB，但属于源码/文档/配置/diff/搜索/普通读取 → Codex 原样处理
模型可见输出 ≥ 4 KiB，且属于明确诊断命令 → 保存 observation → 本地 EPR → decision:block 反馈替换 Tool Result
```

阈值是 `4,096` 个 UTF-8 字节，但阈值不是资格条件。当前采用保守命令白名单：测试、构建、编译、typecheck、lint，以及 `docker logs`、`kubectl logs`、`journalctl` 等明确日志命令可以进入压缩；包含 `cat`、`sed`、`rg`、`grep`、`head`、`tail`、`jq`、`find`、`tree`、`git diff/show/log/status/blame` 的输出不进入 Observation Pack 或 EPR。组合命令只要包含这些高密度读取操作就整体放行，避免把源码与一次测试拼接后误压缩。不确定的命令也原样放行。

真实 Codex 0.154.0 验证中，28.7 KiB 的进程输出在 Hook 前已成为约 4.1 KiB 的模型可见截断结果；使用 8 KiB 会漏掉这种输出。符合诊断白名单的大输出保存在：

```text
~/.sol/observations/projects/<project-key>/obs_<24位十六进制>/
├── meta.json
├── raw.txt
└── reduced.txt
```

`project-key` 是规范化项目根目录的 SHA-256：Git 仓库内从任意子目录启动都会归到同一个 namespace；非 Git 目录使用会话 `cwd`。`sol observation read/search/meta` 也只解析当前项目 namespace，因此仅知道另一个项目的 observation ID 仍无法跨项目读取。

这里的 `raw.txt` 是 Codex 传给 `PostToolUse` 的 `tool_response`。Codex 源码中的 `ExecCommandToolOutput` 虽然持有截断前的 `raw_output`，但 `post_tool_use_response()` 明确把 `truncated_output_with_policy(model_output_policy())` 交给 Hook。`model_output_policy()` 又取以下两项中更小的预算：

- 会话级 `tool_output_token_limit`
- 本次 `exec_command`/`write_stdin` 的 `max_output_tokens`

因此，只提高顶层配置没有效果；本次工具调用仍可使用更小的默认值。Codex 0.154.0 的独立进程实测中，同时设置：

```toml
# ~/.codex/config.toml
tool_output_token_limit = 12000
```

并让每次调用显式携带 `max_output_tokens: 12000` 后，28,700 bytes、700 行的测试输出完整进入 Hook，中间第 512 行错误也被 EPR 保留。可以在项目 `AGENTS.md` 中加入类似约束：

```text
调用 exec_command 或 write_stdin 时总是显式设置 max_output_tokens=12000；
不要降低该值，大输出由 SoL PostToolUse Hook 归档和压缩。
```

这是一种尽力而为的配置，不是完整性保证：模型可能漏传参数；Hook 自身无法在执行前强制补上该字段；约 12K token 以上仍会截断；统一执行器当前还有约 1 MiB 的底层采集上限。`meta.json` 因而继续保守地将 `captureComplete` 记录为 `unknown`。

如果必须保证保存任意大小的完整 stdout/stderr，需要在命令执行源捕获、订阅 App Server 的 `item/commandExecution/outputDelta`，或小幅修改 Codex。命令 wrapper/tee 会改变命令字符串、shell/重定向和可写路径语义；App Server 客户端需要做流事件关联和生命周期管理；本 MVP 按“大输出少见且允许极端截断”的约束不采用它们。

首版 EPR 是本地确定性 reducer，不调用模型。它只处理上述低密度诊断输出，选取 error/failure、expected/actual、warning、文件行号、stack frame 和测试摘要等行，随后使用与 OMP EPR 相同的 SoL 精确引用校验器验证每条 quote。receipt 明确警告“引用真实不代表摘要完整”。

Codex 0.154.0 的 2026-09-14 实测中，文档所述的 `continue:false`/`stopReason` 和 `continue:false`/`reason` 都运行了 Hook，却没有替换该 `codex exec` 工具结果；`decision:"block"`/`reason` 成功让下一次模型请求只看到 EPR feedback。因此 MVP 使用后一种形式。代价是 Codex 会把已执行完毕的工具结果标成 rejected/error；命令副作用不会撤销，receipt 仍记录可见的退出状态。Code Mode 中 Promise 会被拒绝，所以本适配当前只建议用于普通原生 Bash/`exec_command` 路径。

退出码只接受 `tool_response.exitCode/exit_code` 或其 `details` 中的整数元数据，绝不从正文推断。当前实测 Hook 合约只传模型可见文本，不传结构化 `exit_code`；因此 receipt 使用 `status=unknown`、`exit_code=unknown`，但仍可标出实际观察到的 failure evidence。源码或日志中的 `process.exitCode = 1`、JSON 示例及“Process exited”字符串都不能成为宿主状态。

不要把 Hook 的“超长 stdout 自动落盘”能力误认为原始工具输出保存机制：该能力处理的是 Hook 程序返回给 Codex 的过长文本，不是 Codex 传入 Hook 的 `tool_response`。

## 用户级安装

从当前 checkout 执行一次：

```bash
cd /home/carter003/project/sol-omp/sol-omp
bun src/codex/cli.ts codex install-user
```

安装器会幂等合并而不是覆盖：

- `~/.codex/config.toml`：设置顶层 `tool_output_token_limit = 12000`
- `~/.codex/hooks.json`：保留已有 Hook并追加用户级同步 `PostToolUse`
- `~/.codex/AGENTS.md`：追加每次 `exec_command`/`write_stdin` 显式使用 `max_output_tokens=12000` 的全局指令

Hook 命令使用 adapter 的绝对路径，因此对其他项目同样生效。移动或删除该 checkout 前必须重新安装或移除该 Hook。

安装后启动一个新的 Codex 会话，通过 `/hooks` 审查并信任新增 Hook；Codex 按 Hook 定义哈希保存信任，adapter 路径或 Hook 定义变化后需要重新审查。

## 手工配置 Hook

将 [`codex-hooks.example.json`](../codex-hooks.example.json) 的内容放入项目的 `.codex/hooks.json` 或用户的 `~/.codex/hooks.json`。示例中的路径适用于当前 SoL-Pi checkout；如果目录不同，改成 `src/codex/cli.ts` 的绝对路径。

Codex 会要求审查并信任新增 Hook。通过 `/hooks` 查看并确认。Hook 必须保持同步；不要添加 `"async": true`，否则不能替换原始结果。

为了尽量扩大符合条件的诊断日志可见范围，还需要同时设置上面的 `tool_output_token_limit`，并通过项目指令让普通 `exec_command`/`write_stdin` 显式使用相同的 `max_output_tokens`。不要在当前适配器中使用 Code Mode 执行这类命令：Code Mode 还有独立的外层输出预算，且 `decision:"block"` 会令嵌套调用的 Promise reject。源码、文档和搜索命令即使超过阈值也原样返回。

直接验证适配器：

```bash
cd /absolute/path/to/SoL-Pi/sol-omp
bun run typecheck
bun test tests/codex-adapter.test.ts

node -e 'process.stdout.write(JSON.stringify({hook_event_name:"PostToolUse",session_id:"s",turn_id:"t",tool_name:"Bash",tool_use_id:"c",tool_input:{command:"npm test"},tool_response:"small"}))' \
  | bun src/codex/cli.ts codex post-tool-use
```

最后一条命令应无 stdout，因为小输出完全沿用 Codex 原路径。

## 局部读取

如果已通过 `bun link` 暴露 `sol` 命令：

```bash
sol observation meta obs_...
sol observation read obs_... --offset 0 --max-bytes 12000
sol observation search obs_... --query FAIL --context-lines 3
```

也可以不安装命令，直接运行：

```bash
bun /absolute/path/to/SoL-Pi/sol-omp/src/codex/cli.ts observation meta obs_...
```

`read` 默认最多返回 12,000 字节；只有显式传入 `--all` 才读取全部。SoL 自己的 observation 读取命令会跳过再次打包，避免递归。

## 失败策略

归档、EPR 或 receipt 校验失败时，Hook 以成功状态结束但不写 stdout，Codex 继续使用原工具结果。stderr 只写固定错误提示，不回显日志、请求或认证信息。
