# Action Fusion：AF-OMP-001

状态：**BLOCKED / 未实现**。分析对象严格固定为 OMP `v18.1.18`，commit `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`。这是源码接口核对结果，不是已经执行的运行时权限验收。

## 所需能力

在一次原生 edit/write 委托后执行 then_run 时，后续命令必须独立经过 bash 的现有审批、拒绝规则和扩展 tool_call 拦截。不能让“edit 获批”隐含允许执行任意 shell。

## 实际核对的入口

| 入口 | 固定源码证据 | 结论 |
|---|---|---|
| `ctx.invokeTool(params)` | `types.ts` 480–550；`wrapper.ts` 70–99 | 仅能调用当前重新注册的同名原生工具，不能从 edit 转到 bash |
| `api.getAllTools()` | `types.ts` 中 ToolInfo 与 API 声明 | 返回名称、Schema、来源元数据，不提供受保护的任意工具执行句柄 |
| `api.exec(command,args,options)` | `loader.ts` 270–280 | 直接转发到 execCommand，不经过 bash 工具包装层 |
| `execCommand()` | `exec/exec.ts` 30–52 | 直接调用 ptree.exec；仅处理 cwd、超时、取消和输出，不做工具审批/拦截 |
| 正常工具调用 | `wrapper.ts` 181–280 | 这里才解析 tools.approvalMode / tools.approval、拒绝、发出 tool_call 并重新审批修改后的参数 |

逐项核对上述公开 ExtensionAPI/ExtensionContext 后，没有找到满足本计划的跨工具受保护派发入口。不把 getAllTools 元数据包装成虚构 getTool，也不实例化原生 BashTool、调用内部 runner、手工重放审批或直接启动进程。

## 本次处理

`src/omp/action-fusion.ts` 只提供能力守卫，不是融合实现。`actionFusion: false` 时没有 edit/write 覆盖，也没有后续命令入口。显式改成 true 会在任何工具/事件注册前明确拒绝加载，错误要求改回 false，因此不会“修改已发生又回退再编辑一次”。

ObservationPack 可独立开发和测试。只有接通满足上述条件的公开宿主能力后，才能加入融合实现，并真实验证：允许 edit / 禁止 bash；另一扩展阻断 bash；编辑失败；命令非零；取消；禁止重复修改。当前这些 Action Fusion 运行时场景全是 **NOT_RUN**，不能写 PASS。

## 本轮复核与用户选择

2026-09-12 再次检查当前安装包、实际独立二进制及官方发布源。npm `latest` 和 GitHub 最新 release 均为 `18.1.18`，没有已发布的受保护任意工具派发升级可用。真实客户端探针正常退出（exit 0），确认 `ExtensionAPI`/普通事件 `ExtensionContext` 不提供绑定当前会话的任意工具执行方法。

补充核对了先前未展开的公开 SDK 导出：

- `dispatchXdevTool`、`ExtensionToolWrapper`、`EvalTool` 等确实存在于注入的 `api.pi` 导出中；**导出构造器/函数不等于拿到了当前会话的实例、registry、runner 或执行 context**。所需的 `ToolSession`/`XdevState` 不在扩展 API 中。
- 从覆盖后的 write 使用同名委托写入 `xd://bash` 不是通用安全替代：原生 WriteTool 会设置 `xdevApproved:true`，不能假定此次内部调用经过了原本基于 bash 参数的外层审批。没有用这一途径执行命令。
- 原生 eval 的 `callSessionTool(name,args,{session,...})` 会从当前会话的受保护工具 registry 取工具、传递当前 context 和取消信号；扩展无法获得该绑定 session。模型调用原生 eval 时则由宿主完成绑定，`tool.*` 可以保留内层工具审批及 `tool_call`。

用户明确选择 **OMP 原生 eval 顺序融合**，而非放开扩展权限或修改 core。本轮配置 `providers.openai-codex.codeMode=on`、`bash.autoBackground.enabled=false`，保留 `actionFusion=false`。原生方案的成功/失败/审批/取消及三对对照已实际执行，见 [验证报告](validation-report.md)；不能将其改记为本文件的 sol-omp Action Fusion PASS。

依据：[npm dist-tags](https://registry.npmjs.org/-/package/@oh-my-pi%2Fpi-coding-agent/dist-tags)、[v18.1.18 release](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.18)、[原生 eval bridge](https://github.com/can1357/oh-my-pi/blob/v18.1.18/packages/coding-agent/src/eval/js/tool-bridge.ts)。真实运行的公开导出清单保存在 [原生融合结构化证据](native-fusion-comparison-2026-09-12.json) 的 `capabilityEvidence`。

## 固定来源

- [ExtensionContext / ExtensionAPI](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/types.ts)
- [同名委托与权限包装层](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/wrapper.ts)
- [ConcreteExtensionAPI.exec](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/loader.ts)
- [execCommand](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/exec/exec.ts)

任务依据：`implementation-plan-mvp.md` 第 6 节要求命令保留权限/拦截，缺少接口时保持该功能关闭，继续交付 ObservationPack。
