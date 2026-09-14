# OMP 上下文预算突增修复（2026-09-14）

## 症状与根因

Observation Pack 的目标是把完整工具结果留在本地归档，仅把可恢复引用交给主模型。但原实现同时存在三条泄漏路径：

1. `FULL_SENDS=2` 明确允许同一个大结果进入前两次 provider 请求。
2. `read/grep/glob/edit/write/eval`、检查型 Bash 和错误结果被排除，可能永远不打包。
3. EPR 没有生成 receipt 时把原消息加入 `retained`，阻止后续 Observation Pack 接管。

因此一次较大的读取或若干工具结果可在 Context hook 后仍进入 provider 输入，足以造成上下文百分比突增。OMP 原生 artifact spill 只缩小 session 消息中的预览；若适配层不恢复 artifact，也无法保证 SoL 归档保存的是完整源。

## 修复

- 全文发送次数改为 0；超过 10 KiB 的非空纯文本结果从首次 provider 请求前即投影为占位。
- 删除基于工具名、命令类型和错误状态的排除；仅跳过有硬分页上限的 `obs_recall`、混合内容、小结果及已验证 EPR receipt。
- 从公开 `sessionManager.getArtifactPath()` / `getArtifactsDir()` 恢复宿主截断结果，校验完整后才写入 SoL Observation archive。
- artifact 恢复或归档失败时 fail-open：保留宿主给出的原始消息并告警，不创建声称完整但实际截断的引用。
- EPR 只有成功生成并验证 receipt 时才加入 `retained`；失败回退交给通用 Observation Pack。

## 边界

修复不修改 OMP core、原版 Pi 或 `node_modules`，也不改写 session history；它只改变发送给 provider 的 Context 副本。若宿主没有提供完整 artifact，适配层不能凭空恢复缺失字节，此时按安全策略保留预览。这是明确的 fail-open 边界，不是已知的正常路径泄漏。

## 验证

- Observation Pack 单元测试覆盖首次投影、读取/搜索/edit/eval/Bash、错误结果、完整 artifact 恢复、artifact 缺失 fail-open、归档完整性和逐页恢复。
- Reducer 单元测试覆盖 verified receipt 保留与所有失败回退由 Observation Pack 接管。
- 最终 `typecheck`、完整测试和固定版本 smoke 结果记录在 `docs/validation-report.md`。
