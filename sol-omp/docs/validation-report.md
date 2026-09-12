# sol-omp 验证报告

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
