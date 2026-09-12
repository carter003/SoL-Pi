# Evidence-Preserving Reducer 根因分析

日期：2026-09-12。

项目：`/home/carter003/project/sol-omp`；适配包：`sol-omp/`。

分析基线：实现前 `eea74a7d410f7d7b016413760fabff4afc2c7759`；实现判断以分析时实际工作区为准，没有重置或覆盖未提交修改。

本报告记录此前完成的只读根因分析。归档本身由用户随后明确要求；没有修改源码、配置或依赖，没有新增前台／Reducer 基准请求，没有自动提交。此前 3 项 high 依赖告警仍未解决，安全审计仍为 FAIL。

## 1. 结论摘要

本轮不是单一原因，也不是“压缩率无效”。三个指标应分别归因：

| 指标 | 主要解释 | 证据强度 |
|---|---|---|
| 估算费用增加 | 前台普通输入与缓存输入的计价构成变化；最大差额发生在 receipt 生效之前 | FACT：账目与时序均可直接定位；缓存冷热差异的具体后端原因仍 UNKNOWN |
| 总 token 增加 | session_stop 接入错过首次读取；OP 已压缩后期重放，EPR 每条日志实际上只额外缩短一次请求，不足以抵消辅助模型输入 | FACT：Context 轨迹和 usage 对得上 |
| 累计耗时增加 | Reducer 位于串行 settle 路径，新增约 6.355 秒；前台模型累计耗时反而略降 | FACT：计时账目可闭合 |
| 实现问题 | 三对成功样本没有发生压缩失败或关键证据遗漏；但存在 90 秒辅助超时与宿主默认 30 秒 handler 预算不匹配的潜在生命周期缺陷，以及过宽保留集合损失 OP 收益的问题 | 源码预算不匹配是 FACT；慢请求可能越过宿主等待边界是 INFERENCE；均不是这三对涨幅的已证实原因 |

最有区分力的数字：

- 总费用涨额：**$0.121415825**。
- Reducer 直接费用：**$0.001039825，占涨额 0.856%**。
- **receipt 生效前**的前台差额：**+$0.130358**。
- receipt 生效后的两次复核合计：**−$0.009982**；这仍是观测差额，不是缓存受控的因果效应。
- 前台少用 **8,800 token**，辅助模型新增 **12,903 token**，净增 **4,103 token**。
- 前台模型累计时间 **−0.373 秒**，Reducer **+6.355 秒**，其余阶段净增 **0.550 秒**。

**费用上涨主要是本次配对的缓存计价构成不一致；token 不划算主要是适配时序与 OP 重叠，再叠加短任务设计；耗时上涨主要是串行辅助调用。不能把三者统称为“EPR 打破缓存”。**

### 1.1 已知环境与结果

- OMP 18.1.18，Bun 1.3.14。
- 主模型：`openai-codex/gpt-6-astra`，high。
- Reducer：`opencode-go/glm-5.3-flash`。
- ObservationPack=true，evidencePreservingReducer=true，默认 timeout=90000 ms。
- `sol-omp.actionFusion=false`，`providers.openai-codex.codeMode=on`，`bash.autoBackground.enabled=false`，均保持不变。
- 仅验证过合成日志，未发送业务日志。

| 指标 | Reducer off | Reducer on |
|---|---:|---:|
| 前台模型调用 | 12 | 12 |
| Reducer 调用 | 0 | 3 |
| 前台 token | 158690 | 149890 |
| Reducer token | 0 | 12903 |
| 总 token | 158690 | 162793 |
| 前台标价估算 USD | 0.414500 | 0.534876 |
| Reducer 标价估算 USD | 0 | 0.001039825 |
| 总标价估算 USD | 0.414500 | 0.535915825 |
| 累计耗时 | 73.313 s | 79.845 s |
| Context 观察累计重放字节 | 123720 | 68443 |

这些结果是用户提供的已知事实。本分析读取既有证据进行拆解，没有重跑模型来重新确认它们。

## 2. 成本归因

### 2.1 证据口径

- **FACT**：实际日志、分析时工作区源码或官方资料直接支持。
- **INFERENCE**：机制支持，但没有隔离混杂因素。
- **UNKNOWN**：现有证据不能回答。

以下代码路径相对于 `sol-omp/`。私有证据根记为：

```text
P=/tmp/sol-omp-epr-runtime-xf8oonnb
```

六个配对 session 路径记录在 [epr-comparison-2026-09-12.json](epr-comparison-2026-09-12.json):83–696。逐请求 usage、duration、TTFT 来自各 session JSONL 的 **6、10、12、14 行**；投影来自对应 `P/pair-*/probe.jsonl:2,7,9,11`。

证据窗口注意：`pair-3-on` 的 session 后来追加了恢复读取请求，第 17、20 行不属于本次四响应配对窗口，未混入本报告配对表。

分析时已找到并读取本次需要的配对日志、receipt 和归档，没有遇到这些已引用临时文件缺失；但日志未提供完整请求级缓存路由与账单证据。临时文件仍可能被系统后续清理。

### 2.2 每个前台请求

阶段定义：

- **R1**：首次执行中的工具调用生成请求；此时还没有日志。
- **R2**：工具执行后首次读日志并回答。
- **R3**：首次复核。
- **R4**：第二次复核。

计价沿用本轮宿主目录：普通输入／缓存读取／输出为 **$10／$1／$50 每百万 token**。

表内 token 三元组为 **普通输入 / cacheRead / 输出**；费用三元组顺序相同，单位 **mUSD，即 $0.001**。**所有请求的 cacheWrite token 与对应记录费用均为 0**。时间为宿主记录的 **duration / TTFT，秒**；TTFT 是 duration 的子集，不能再相加。

| 配对 | 请求 | 所见日志 | token：I/R/O | 费用：I/R/O，mUSD | 合计 mUSD | duration / TTFT |
|---|---|---|---:|---:|---:|---:|
| 1 off | R1 | 无日志 | 11104/0/62 | 111.040/0/3.100 | 114.140 | 4.008/2.396 |
| 1 off | R2 | 全文 | 3779/11008/92 | 37.790/11.008/4.600 | 53.398 | 4.430/1.694 |
| 1 off | R3 | 全文 | 322/14592/108 | 3.220/14.592/5.400 | 23.212 | 4.900/1.648 |
| 1 off | R4 | OP 占位 | 725/11008/103 | 7.250/11.008/5.150 | 23.408 | 4.804/1.862 |
| 1 on | R1 | 无日志 | 11104/0/61 | 111.040/0/3.050 | 114.090 | 4.031/2.411 |
| 1 on | R2 | 全文 | 3778/11008/86 | 37.780/11.008/4.300 | 53.088 | 5.502/2.620 |
| 1 on | R3 | receipt | 770/11008/116 | 7.700/11.008/5.800 | 24.508 | 6.518/2.824 |
| 1 on | R4 | receipt | 274/11648/76 | 2.740/11.648/3.800 | 18.188 | 7.612/5.234 |
| 2 on | R1 | 无日志 | 480/10624/61 | 4.800/10.624/3.050 | 18.474 | 5.055/3.459 |
| 2 on | R2 | 全文 | 3778/11008/83 | 37.780/11.008/4.150 | 52.938 | 4.575/2.076 |
| 2 on | R3 | receipt | 828/11008/117 | 8.280/11.008/5.850 | 25.138 | 6.003/2.488 |
| 2 on | R4 | receipt | 333/11648/82 | 3.330/11.648/4.100 | 19.078 | 4.987/2.514 |
| 2 off | R1 | 无日志 | 96/11008/61 | 0.960/11.008/3.050 | 15.018 | 4.190/2.595 |
| 2 off | R2 | 全文 | 194/14592/88 | 1.940/14.592/4.400 | 20.932 | 6.911/4.302 |
| 2 off | R3 | 全文 | 317/14592/125 | 3.170/14.592/6.250 | 24.012 | 5.447/1.759 |
| 2 off | R4 | OP 占位 | 735/11008/89 | 7.350/11.008/4.450 | 22.808 | 5.791/3.140 |
| 3 off | R1 | 无日志 | 480/10624/62 | 4.800/10.624/3.100 | 18.524 | 4.905/3.083 |
| 3 off | R2 | 全文 | 3779/11008/85 | 37.790/11.008/4.250 | 53.048 | 7.066/3.209 |
| 3 off | R3 | 全文 | 315/14592/122 | 3.150/14.592/6.100 | 23.842 | 6.872/3.220 |
| 3 off | R4 | OP 占位 | 730/11008/77 | 7.300/11.008/3.850 | 22.158 | 5.021/2.716 |
| 3 on | R1 | 无日志 | 11104/0/61 | 111.040/0/3.050 | 114.090 | 4.543/2.923 |
| 3 on | R2 | 全文 | 3778/11008/79 | 37.780/11.008/3.950 | 52.738 | 4.147/1.790 |
| 3 on | R3 | receipt | 765/11008/116 | 7.650/11.008/5.800 | 24.458 | 5.587/1.913 |
| 3 on | R4 | receipt | 269/11648/75 | 2.690/11.648/3.750 | 18.088 | 5.416/3.180 |

`pair-1-off R4` 另记录 reasoningTokens=24；它不是需要再加一次的额外 token 或费用。

#### Reducer 自身

三次均在 **R2 完成之后、R3 之前**运行；每次一次调用、一个已完成 attempt，cacheRead/cacheWrite 均为 0。

| 配对 | 输入 | 输出 | 总 token | 输入费用 USD | 输出费用 USD | 合计 USD | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 on | 4,165 | 134 | 4,299 | 0.000312375 | 0.000033500 | 0.000345875 | 1.938 s |
| 2 on | 4,165 | 149 | 4,314 | 0.000312375 | 0.000037250 | 0.000349625 | 2.348 s |
| 3 on | 4,161 | 129 | 4,290 | 0.000312075 | 0.000032250 | 0.000344325 | 2.069 s |

来源：结构化数据各 `pairs[].reducer`；调用计数与费用累加实现见 `src/omp/reducer-provider.ts:69–120`。

### 2.3 每对和整体的费用差额

全部为 **on − off**，USD：

| 配对 | 普通输入变化贡献 | cacheRead 变化贡献 | 输出变化贡献 | Reducer 直接费用 | 总费用差额 | 总 token 差额 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | −0.000040 | −0.002944 | −0.001300 | +0.000345875 | **−0.003938125** | +1,325 |
| 2 | +0.040770 | −0.006912 | −0.001000 | +0.000349625 | **+0.033207625** | +1,459 |
| 3 | +0.106120 | −0.013568 | −0.000750 | +0.000344325 | **+0.092146325** | +1,319 |
| **整体** | **+0.146850** | **−0.023424** | **−0.003050** | **+0.001039825** | **+0.121415825** | **+4,103** |

对应 token 变化：普通输入 **+14,685**，cacheRead **−23,424**，输出 **−61**，前台合计 **−8,800**。

**FACT：** 第三对贡献了整体费用净涨额的 **75.9%**；第一对反而略省钱。费用上涨不是三个样本均匀发生。

上述是完整的标价算术归因，不是“EPR 导致这些输入变成非缓存输入”的因果证明。

#### 按阶段定位

| 阶段 | 三对前台费用差额 USD | 能否由 receipt 改写解释 |
|---|---:|---|
| R1：尚无日志 | **+0.098972** | 不能，尚无可改写观察 |
| R2：两组均首次读全文 | **+0.031386** | 不能归因于 receipt 替换 |
| R3：全文对 receipt | +0.003038 | 存在投影变化，但缓存因果贡献未隔离 |
| R4：OP 占位对 receipt | −0.013020 | 同时包含 OP 改写、缓存状态与输出差异 |

第三对 R1 的 **+$0.095566** 尤其明确：on 为零 cacheRead，off 已有 10,624 cacheRead；两者普通输入加缓存输入均为 11,104。日志尚未产生，EPR 压缩不可能是这笔差额的直接原因。

### 2.4 能否区分“压缩破坏缓存”和“配对冷热不同”？

可以排除部分错误归因，但不能完整分离两者。

1. 运行顺序为 off/on、on/off、off/on；所有配对使用不同 session，没有控制供应商缓存。来源：`docs/validation-report.md:51–54`、各 session 第 2 行时间与 ID。
2. R1 可见用户内容相同；去掉 timestamp/id 后，其 Context 消息相同。但 probe 不包含完整渲染后的 system prompt、工具定义和实际请求路由。
3. 同一 session 内：on 的 R2→R3，旧消息内容变化位于第 3 条消息，即 toolResult；off 的 R2→R3，旧消息内容不变；off 的 R3→R4，toolResult 变成 OP 占位；on 的 R3→R4，已有消息内容保持稳定。来源：各 `probe.jsonl:7,9,11`。早期 assistant 的 completedAt/contextSnapshot 也有元数据补写，不能把整个对象差异都当发送内容变化。
4. R3 三个 on 均读到 11,008 cached token，而 off 为 14,592；R4 则 on 为 11,648，off 为 11,008。**INFERENCE：** 这与“EPR 提前改写观察所在后缀、OP 稍后才改写；稳定 receipt 后续又可复用”一致，不是整段缓存全部失效。
5. OMP 的 Codex 请求确实设置 prompt_cache_key，默认取显式 key 或 sessionId；SDK 默认 provider sessionId 来自本地 session。不同 session 会改变客户端缓存亲和信息，但并不保证冷／热命中。固定源码：[openai-shared.ts:481–500](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/ai/src/providers/openai-shared.ts#L481-L500)、[sdk.ts:1449–1467](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/sdk.ts#L1449-L1467)。

**UNKNOWN：** 实际完整前缀 hash、每请求实际 cache key/后端亲和、缓存驻留与淘汰、供应商命中诊断。因此不能将 R3 的 3,584-token cacheRead 差额全部精确归因于 EPR，更不能将全轮 +$0.1214 归因于压缩。

## 3. 时序、OP 重叠与耗时

### 3.1 off 组已经压缩，EPR 只额外缩短一次请求

| 请求 | off：OP 已开启 | on：OP＋EPR |
|---|---:|---:|
| R1 | 无日志 | 无日志 |
| R2 | 全文 19,957 B | 全文 19,957 B |
| R3 | 全文 19,957 B | receipt 1,384／1,518／1,384 B |
| R4 | OP 占位 1,326 B | 相同 receipt |

- 每条日志只有 R3 被 EPR 额外缩短。
- R4 的 receipt 比 OP 占位还大 58／192／58 字节。
- 不是“两个后续请求都从全文缩成 receipt”；第二个后续请求的正确基线已经是 OP 占位。
- 三对累计少重放 55,277 字节，并不意味着前台 token、所有模型 token 或费用按相同比例下降。

原版与本地 OP 都是 FULL_SENDS=2，之后占位；本地使用投影计数和历史 assistant 数恢复，不是服务器计费发送计数。来源：`src/upstream/sol-pi/observation-pack/observation.ts:16–21,102–106`、`src/omp/observation-pack.ts:70–92`、[锁定上游 OP index.ts:137–201](https://github.com/NVlabs/SoL-Pi/blob/d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0/src/sol-pi/extensions/observation-pack/index.ts#L137-L201)。

#### 原文回退保护的额外影响

`EvidencePreservingReducer.project()` 不仅保留明确失败候选，还保留：尚无 receipt 的候选；没有 target 状态的所有 bash/eval，包括重启后的历史消息；无法安全匹配的 eval。这些消息进入 retained，OP 直接跳过。来源：`src/omp/evidence-preserving-reducer.ts:169–196`、`src/omp/observation-pack.ts:78–80,161–163`。

**FACT：** 不能说“EPR 失败也没有损失，OP 还会兜底压缩”。当前策略恰好是：失败后保留全文，并阻止 OP 替换它。

**INFERENCE：** 对长时间不 settle 的任务、无 receipt 的历史 bash/eval，以及已知不需要 EPR 的大结果，这个保守范围可能让 EPR-on 比 OP-only 重放更多全文。该影响在这组三对成功短样本中没有展开测量。

### 3.2 耗时拆解

单位秒：

| 配对/状态 | 前台 duration 累计 | Reducer | 剩余时间 | 实验累计耗时 |
|---|---:|---:|---:|---:|
| 1 off | 18.143 | 0 | 2.848 | 20.991 |
| 1 on | 23.662 | 1.938 | 2.960 | 28.559 |
| 2 off | 22.339 | 0 | 2.974 | 25.314 |
| 2 on | 20.620 | 2.348 | 3.189 | 26.157 |
| 3 off | 23.865 | 0 | 3.144 | 27.008 |
| 3 on | 19.693 | 2.069 | 3.367 | 25.128 |
| **off 合计** | **64.347** | **0** | **8.966** | **73.313** |
| **on 合计** | **63.974** | **6.355** | **9.516** | **79.845** |

剩余时间是实验耗时减去前台 duration 和 Reducer duration，不是单独测得的 I/O 时间。

- native bash details.wallTimeMs 合计：off **0.504 秒**，on **0.499 秒**。来源：各 `probe.jsonl:5`。
- 扣除 bash 后，未分配部分：off **8.461 秒**，on **9.017 秒**。
- 前台 TTFT 累计：off **31.623 秒**，on **33.432 秒**；它已经包含在前台 duration 中。

闭合关系：

```text
Δt = -0.372569 + 6.354601 - 0.005611 + 0.555881
   = 6.532302 s
```

**FACT：** 增加的等待主要来自串行 Reducer，而不是前台模型累计变慢。

**UNKNOWN：** 归档、fsync、receipt 校验、投影复核、eval 编排、RPC/驱动同步分别占多少。源码能证明：辅助计时在归档完成后开始，不包含首次归档；接受 receipt 前再次校验归档，每次投影还会复核；当前 archiveBody 在既有对象分支也执行 sync。来源：`src/omp/evidence-preserving-reducer.ts:127–151,188–191`、`src/omp/reducer-provider.ts:49–60,118`、`src/upstream/sol-pi/evidence-preserving-reducer/archive.ts:45–74`。

不能未经测量把本地 I/O 称为主要瓶颈。模型时间相加也不是并发任务的通用墙钟公式；这里只因实验顺序执行、Reducer 被 await，才能这样对账。

## 4. 上游设计、OMP 限制与本地适配

本次核对时，**NVlabs/SoL-Pi 官方 main 实际也指向 d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0**，与所选 fork 固定提交相同；这是核对结果，不是预设。重要差异主要发生在本地适配。

| 项目 | 官方／锁定上游 | OMP 18.1.18 与本地适配 | 收益或安全代价 |
|---|---|---|---|
| 首次读取 | EPR 在 tool_result 中 await 归约并返回替换内容 | 只收集工具结果；session_stop 后缓存 receipt，随后 Context 使用 | 丢失首次读取节省，并在回答后增加 settle 等待。来源：上游 EPR index:115–163,179–196；本地 EPR:102–153,202–214 |
| 原会话保留 | 上游返回工具结果替换 | 本地只投影新数组／消息，不改 session 原文 | 改善可恢复性；不是上游首次读取收益的等价实现。来源：实施计划:263–275、本地 EPR:169–198 |
| 取消入口 | 不能直接假设 Pi 生命周期适用于 OMP | tool_result/context/turn_end/agent_end 无公开 signal；session_stop 有 | 在透明扩展约束下选择 settle 有依据。来源：OMP shared-events:97–107,171–217、extensions/types:988–1028 |
| Context 的底层 signal | 底层 Agent 有带 signal 的转换路径 | SDK 的扩展桥接明确丢弃 _signal，再调用 emitContext | 不能用类型断言给扩展伪造 signal。来源：OMP sdk:3414–3417 |
| 子代理／长任务 | 工具结果阶段可生效 | 子代理跳过 session_stop；主任务未 settle 时也不归约 | 这些场景不能承诺压缩收益，保留集合还可能阻止 OP。来源：OMP agent-session:4110–4138 |
| 重启 | 不应推定上游状态可直接继承 | receipt 仅内存缓存；重启不重新处理旧日志，未知 bash/eval 保留全文 | 不重复花钱，但旧摘要收益消失。来源：本地 EPR:30–35,109–112,177–184；UPSTREAM:75–76 |
| 原文来源 | 上游可读取校验过的 Pi bash 全量日志，并支持 then_run | 本地只取实际 native bash 文本；eval 要唯一精确匹配，不猜私有 artifact | 保留审批与关联安全，但宿主已截断的内容无法恢复。来源：上游 candidate:29–100；本地 candidate:20–33、EPR:157–166 |
| 公开模型认证 | 原 Pi provider 实现 | ModelRegistry.find/getApiKey(...,{signal})＋completeSimple | 无需读取认证文件；认证与请求受本地 signal 控制。来源：本地 reducer-provider:62–105 |
| 超时预算 | 沿用 90 秒 reducer 默认值 | OMP 普通 handler 默认 30 秒；本地每次辅助调用最多 90 秒，整个候选队列没有共享的 30 秒内截止时间 | 潜在生命周期缺陷，见下文 |

固定来源：

- [SoL-Pi EPR index](https://github.com/NVlabs/SoL-Pi/blob/d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0/src/sol-pi/extensions/evidence-preserving-reducer/index.ts#L115-L196)
- [SoL-Pi candidate](https://github.com/NVlabs/SoL-Pi/blob/d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0/src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts#L29-L100)
- [OMP shared-events](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/shared-events.ts#L97-L217)
- [OMP extensions/types](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/types.ts#L988-L1028)
- [OMP SDK Context bridge](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/sdk.ts#L3414-L3417)
- [OMP session_stop dispatch](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/session/agent-session.ts#L4110-L4138)

### 4.1 session_stop 不是整个 OMP 的唯一安全公开接口

应把结论限定为：在现有 CLI 中，作为透明扩展处理任意原生工具结果，又要求异步辅助调用绑定当前 run 取消时，18.1.18 没有满足全部约束的前读 tool_result/context 扩展入口。

另外确实存在公开路径，但代价不同：

1. **新增独立、明确用途的前读工具**：ToolDefinition.execute(...,signal,...,ctx) 有真实 signal 和正式 approval。它不是包装或覆盖原生工具，亦不能透明接管所有现有调用。来源：[types.ts:622–661](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/types.ts#L622-L661)。
2. **SDK 宿主整合**：公开 session.agent 有带 signal 的 afterToolCall、前模型调用钩子；但 ExtensionContext 不暴露它。不能当作现有插件已可直接使用的能力，也不能虚构 addBeforeModelCall 可以返回 Context 替换。来源：[agent types:519–531,623–637](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/agent/src/types.ts#L519-L637)。

本轮不建议私有 session、脱离取消控制的后台任务、修改 OMP core，或丢失原生审批语义的同名工具包装。

OMP 当前 main 为 `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`；已核对的 12 个相关事件、SDK、eval、模型与 Codex 文件和固定版本一致。未发现可据此宣称 18.1.18 已具备的新扩展能力，也不宣称整个 main 完全相同。

### 4.2 新发现：90 秒对 30 秒的风险

固定 runner：EXTENSION_HANDLER_TIMEOUT_MS=30000；内部组合 handlerSignal；超时后 Promise.race 返回；传给 handler 的仍是原 event，内部 timeout signal 主要进入 UI 包装，并未替换 event.signal。

来源：[runner.ts:86–120](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/runner.ts#L86-L120)、[249–315](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/runner.ts#L249-L315)、[1275–1312](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/extensibility/extensions/runner.ts#L1275-L1312)。

**INFERENCE：** 单个慢请求，或多个串行候选累计超过 30 秒时，宿主可能已经结束等待，但辅助任务仍在等待自己的 deadline／父取消。不能只把每个候选 timeout 调到 30 秒以下就解决整个队列问题。

本组三次辅助调用都不到 2.4 秒，没有证据显示该问题造成此次涨幅。这是应优先零模型复现的安全边界，不是已发生事故的断言。

## 5. 证据质量与计费适用边界

### 5.1 receipt 没有本组任务关键漏项，但不保证语义正确

三个配对 receipt 都保留了 export worker 被排除、integration smoke checks NOT RUN、unit checks 通过并不声明 integration coverage。原文关键行为归档第 43、123、203 行，实际 receipt 位于各 on 组 probe.jsonl:9；索引见 `docs/epr-comparison-2026-09-12.json:1258–1289`。六个最终答案均为 NO-GO。

但发现了实际语义反例：`P/visible-on/probe.jsonl:12` 中，原文第 3 行：

```text
0000 PASS synthetic unit arithmetic check; deterministic fixture, no business data
```

被标为 **kind=failure**，receipt 同时为 status=success。字符串和 hash 都合法；分类却不正确。

校验器只验证 schema、来源 hash、状态、kind 枚举、quote 在原文中存在等；失败证据检查也只是要求存在 fatal/failure 标签，不验证该引用的真实语义。来源：`src/upstream/sol-pi/evidence-preserving-reducer/receipt.ts:81–142`。

**逐字引用合法 ≠ 分类正确 ≠ 摘要完整 ≠ 当前任务结论已获充分证明。**

### 5.2 首次失败与失败成本

| 场景 | 实际原因与结果 | 成本边界 |
|---|---|---|
| first-on | bash 观察完整；外层 eval 从 19,957 字符缩成约 8,031 字符，含 elided 标记，唯一匹配失败 | 辅助请求前拒绝，0 次 Reducer；不能把后续成功覆盖首次失败 |
| failure-20-targets | 自然返回无法解析 JSON，invalid-json，全文回退 | 已报告 3,136 token、$0.000284375、2.833 秒，没有压缩收益 |
| invalid-citation-boundary | 真模型返回后人为注入不存在的引用 | 已报告 4,290 token、$0.000344325、2.668 秒，没有压缩收益；不是自然错引率 |
| timeout-500ms | 本地 deadline，约 523.6 ms aborted | usage 不完整，零字段不代表零费用 |
| cancel-real | 真实 RPC abort；辅助累计约 158.1 ms | 能证明取消回退，不能证明供应商没有计费 |
| .invalid provider 故障 | 人为路由故障，约 15.54 秒后回退 | 不是服务商自然宕机；用量不完整 |

来源：`docs/validation-report.md:32–49,75–85`；结构化数据 allRuns、negativeScenarios、initialFailures；对应私有 stderr.log。

前置截断须单列：

- failure-20-targets/probe.jsonl:5 的 bash 观察本身已含 83ln elided，目标 target_07..13 在 EPR 输入之前就缺失。
- 该次 EPR 又因非 JSON 回退，不能把缺失目标归因于“成功摘要删掉证据”。
- native eval 的 JSON display 有独立截断；完整 details.jsonOutputs 不会自动成为完整模型文本。来源：[eval.ts:125–154](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/tools/eval.ts#L125-L154)、[818–835](https://github.com/can1357/oh-my-pi/blob/00085d4e7dfdcfbf302c122fa2682b410a0f43d1/packages/coding-agent/src/tools/eval.ts#L818-L835)。

四个辅助用量不完整运行仍是 cancel-real、invalid-citation-host、provider-dns-failure、timeout-500ms。全轮已报告 $2.99892865 只能是已知部分，不能称完整账单。来源：结构化数据 1242–1255、验证报告 71–73。

首次失败记录还包括：初次 TypeScript systemPrompt string/string[] 不兼容；两次初期 eval 代码复制句号导致 SyntaxError；三种无效引用探针注册尝试未命中目标边界；一次驱动过早提交下一 prompt 被宿主拒绝；显式 null timeout 的解析回归先失败再修正。原始记录保留在结构化数据 initialFailures 与验证报告 75–85，不能把后续 PASS 倒写成这些首次尝试成功。

### 5.3 2x usage 有官方解释，但不是再乘二的费用系数

官方 models.dev 历史：

- [促销提交](https://github.com/anomalyco/models.dev/commit/a7bb25199a65da6b9e3d4d7a09a6f68659852eb0)：GLM-5.3-Flash 的输入／输出／缓存读取从 .15/.50/.03 减半到 .075/.25/.015。
- [促销标签固定版本](https://github.com/anomalyco/models.dev/blob/5e2d86b81cf2df5441794cca6f7a1f67830416e2/providers/opencode-go/models/glm-5.3-flash.toml#L1-L11)：名称为 GLM-5.3-Flash (2x usage)，价格与本轮本地目录一致。
- [9 月 9 日结束促销](https://github.com/anomalyco/models.dev/commit/8d079ab2cc7ba67b2932a3efaa79fd948f70afc3)：恢复原价并移除标签。

**FACT：** 本轮目录对应旧促销值。**INFERENCE：** 2x usage 是同额度下约双倍可用量的促销含义，不是“每次额外扣两倍”。

当前 [Go 官方说明](https://opencode.ai/docs/go/#usage-limits) 列 .15/.50/.03 与美元计量额度；[超过额度使用余额](https://opencode.ai/docs/go/#usage-beyond-limits) 取决于账户开关。

不能用当前价改写本轮 UI 的历史算术，也不能把旧目录额当实际扣款。即使仅将三次辅助标价翻倍，新增差额也只有另一个 $0.001039825，仍不足以解释主要涨幅。

OpenAI：

- [Codex 认证说明](https://developers.openai.com/codex/auth/) 区分 ChatGPT 登录的订阅访问与 API key 的按量访问。
- [Codex 计费说明](https://developers.openai.com/codex/pricing/) 承认模型、上下文、推理和缓存影响额度，但不支持直接把本地 API 美元目录换成用户套餐扣额。
- [Prompt caching 官方说明](https://developers.openai.com/api/docs/guides/prompt-caching) 支持“相同前缀复用、相同 session 不保证命中”的机制解释；它不是本轮 OAuth 账单规则的直接证明。
- 当前 [API 价格表](https://developers.openai.com/api/docs/pricing) 还包含 cache-write 等维度，不能据此给本轮记录为 0 的 cacheWrite 补造费用。

**UNKNOWN：** 用户实际套餐、服务端适用促销价、余额回退、credits 扣减及最终账单。

## 6. 盈亏门槛、使用建议与最小改进

### 6.1 应计算 OP 基线上的增量收益

令 A_T 为全部辅助 attempt 的实际 token，A_C 为全部辅助费用；P_off,j/P_on,j 为第 j 次前台请求的实际输入 token（含缓存类别）；O_off,j/O_on,j 为实际输出 token；C_off,j/C_on,j 为按相同价格版本计算的前台费用。

```text
S_T = Σ_j[(P_off,j + O_off,j) - (P_on,j + O_on,j)] - A_T
S_C = Σ_j(C_off,j - C_on,j) - A_C
```

正数才是节省。缓存读 token 仍是 token，不能从 token 收支中剔除。

若假设每次后续请求稳定节省 d_T>0 token、d_C>0 美元：

```text
n_T = ceil(A_T / d_T)
n_C = ceil(A_C / d_C)
```

但本次不满足“每次都节省相同数量”。用 F/R/P 分别表示全文、receipt、OP 占位的同口径 token 数；k 为后续请求中 OP 仍会发送全文的次数：

```text
S_观察(n) = k(F-R) + (n-k)(P-R)
```

本组三对 k=1。如果 R>P，OP 开始占位后的更多复核反而逐次侵蚀 token 收益。

#### 本组可推导到什么程度

- 辅助每条日志约 4,290–4,314 token。
- R3 的整请求输入差额是 3,136／3,073／3,134 token；含历史答案差异，不能全部当纯日志 token。
- 按这个量级，抵消辅助 token 大致需要两次“全文对 receipt”的等价节省；当前 OP 基线只给一次。
- R4 整请求输入反而增加 189／238／179 token。

按历史目录、忽略缓存重建和输出变化，辅助费用只需节省：普通输入约 34.4–35.0 token；缓存输入约 344–350 token。

因此 token 盈亏与费用盈亏完全可以方向相反。3,584 token 从缓存价变普通价，价差为 $0.032256，远大于一次辅助调用的约 $0.000347；但本组不能证明这 3,584 全部由 EPR 导致。

4096 字节只是上游候选阈值，不是经济阈值：

- 4096–10240 B 的观察原本不受 OP 压缩，多次后续读取可能有持续收益。
- >10240 B 的成功观察必须对比 OP 的两次全文／后续占位。
- 没有后续请求时，此接入方式只付辅助成本，没有前台读取收益。

不能使用字符数/4作为实际计费 token。上游 OP 确有此估算函数，但本报告没有将其用于 usage 对账。来源：`observation.ts:23,49–50`。

### 6.2 使用建议——本轮不替用户切换

较适合保留开启的候选：

- 同一主 session 会多次 settle 后继续工作。
- 大诊断日志确实还会被再次读取。
- OP 不会很快替代全文，或 receipt 保留的中间证据能减少后续回读。
- 可接受辅助路由外发及 settle 等待，且语义结论仍由主模型核验。

更适合由用户考虑关闭的任务：

- 一次性运行、一次回答就结束。
- 本组三对这种“首次已读全文、仅两次简短复核、OP 已开启”的短任务。
- 子代理，或长时间不 settle 的连续工具任务。
- 经常重启／切换会话，需要历史摘要持续有效的任务。
- 需要逐条完整诊断、经常整段回读，或不能接受日志外发的业务任务。

长任务本身不是开启理由。对当前接入方式，关键是“有多少次 settle 后的有效重放机会”，不是任务总时长。

### 6.3 按优先级的最小改进候选

| 优先级 | 候选 | 解决什么、依据 | 风险／宿主支持 |
|---|---|---|---|
| P0 | 对整个 settle 队列设置小于宿主 handler 预算、留出清理余量的共享截止时间 | 90 秒单请求默认值与 30 秒 handler 预算不匹配；多个短请求累计也会越界 | 不只是调小每个请求 timeout。需验证认证、请求与取消 drain；固定版本可本地约束，更完整保证需要宿主公开组合 signal。不改 core |
| P1 | 将准入从 ≥4096 B 改为考虑 OP 剩余全文机会的保守增量门槛 | 本组仅一次额外缩短；辅助 token 比前台节省多 | 未来重放次数未知，不能假装自动准确预测。先离线验证，不建设预测平台 |
| P1 | 区分“无需 EPR”与“EPR 失败／未知必须保留” | 当前无 target 的所有 bash/eval 都阻止 OP；经济性跳过若也这样处理，可能越优化越差 | 只能放行已明确可安全交给 OP 的成功观察；秘密、失败、关联不明、重启未知状态不能随意放宽 |
| P2 | 统计按请求阶段、价格版本、usage 完整性分开报告 | 当前总价掩盖 R1/R2 的缓存不平衡；Go 促销目录已变化 | 只记录哈希和白名单指标，不保存 headers、完整 payload。美元估算与套餐／账单分列；无需改变模型路由 |
| P3 | 首次读取收益仅评估正式公开前读能力，不绕过现有安全约束 | 上游主要优势发生在首次读取之前 | 独立专用工具会改变使用方式；SDK 整合不是小插件改动。当前不建议为此包装原生工具、改 core 或自建通用压缩平台 |

不优先建议换更强辅助模型、增加重试、放宽 JSON/引用校验，或仅缩短 receipt 元数据。这些没有证据能解决主要涨幅，部分还会扩大费用或削弱证据约束。

## 7. 最小后续实验计划

以下均是方案，尚未执行。只有第三项需要新的真实模型请求，必须先取得用户确认。

| 实验 | 单一假设 | 控制变量与观测 | PASS / FAIL | 新增调用与费用 |
|---|---|---|---|---|
| A：宿主超时边界 | 宿主 handler 超时后，使用原 event.signal 的异步工作仍可能存活 | 隔离无认证进程，真实固定版 runner；用只等待并响应 signal 的 35 秒探针，不调用 provider；不调小宿主 timeout。观察 handler 返回、探针结束、signal 状态 | 安全 PASS：宿主结束等待时探针已取消并结束；FAIL：宿主已超时而探针仍活动。不要把它冒称真实 provider 超时测试 | 前台 0、Reducer 0，$0 |
| B：OP 增量收益轨迹 | 已开启 OP 时，更多后续复核不一定增加 EPR 的 token 收益 | 内存重放现有原文、receipt、OP 占位，固定内容，只改变后续投影次数；不写归档、不调用 provider。记录每次形式、字节及可用的真实 tokenizer 结果 | PASS：确认本组只多缩短一次全文，之后 receipt 相对占位的负增量可累计；FAIL：实际规则提供了未计入的更多全文节省。缺正确 tokenizer 时，token 结论标 UNKNOWN，不用字符比例补齐 | 前台 0、Reducer 0，$0 |
| C：缓存分层后的费用收益 | 在可比缓存条件下，R3/R4 的增量费用节省能覆盖 Reducer | 同一合成任务、模型/high、OP、原生 eval、审批不变；4 个新 session，off/on、on/off；每个仍为原来的 3 提示、4 响应。记录前缀白名单 hash、阶段 usage、TTFT、全部 attempts；不自动补样 | 仅缓存分层／前缀条件可比时判定：净费用节省且关键结论保持为 PASS；净费用不省为 FAIL。缓存条件仍不匹配则 INCONCLUSIVE，不能强行归因 | 计划前台 16、Reducer 2，共 18 次完成调用。前台目录估算预留约 $0.30–2.50；辅助约 $0.0006–0.0034；总约 $0.301–2.504 |

实验 C 的金额是预算预估，不是 OAuth／Go 实付承诺，也不是保证硬上限。执行前须重新确认价格版本和预算；错误／取消可能有未报告费用，宿主暴露的额外 attempt 必须计入，不自动追加重试或补样。P0 边界应先查清，再讨论真实请求。

## 8. 最终判断

下一步先验证两件不同的事：

1. 安全上先做零模型的 30 秒／90 秒生命周期边界复现。
2. 经济上先验证 OP 基线的增量门槛；之后才值得花钱做缓存分层的配对实验。

现有证据已经足够否定两种笼统结论：

- “总费用增加主要因为辅助模型贵”——不成立，直接费用只占涨额 0.86%。
- “EPR 减少了重放，所以多跑几轮就一定更划算”——不成立，OP 后续占位已经更小，而且当前首次读取无法节省。

本轮真正的问题是：费用实验的缓存条件不等价，而适配时序又把 EPR 的可盈利窗口压缩到 OP 接管前的一次重放。实现还有需要优先处理的生命周期风险，但没有证据把这三对的主要涨幅归咎于 receipt 失效或证据删错。

## 9. 质量优先的补充论证与无模型实测

补充日期：2026-09-12。用户明确优先级为任务质量、完成时间、费用。前文保留初次分析时的推断和计划；本节更新状态：第 7 节实验 A 已执行，B/C 未执行。没有修改源码、配置、依赖或用户功能开关，没有新增真实模型请求。

### 9.1 现有三对实验为什么不能证明质量提高

读取每个配对的 probe.jsonl:9,11，仅筛选工具文本及此前 assistant 文本，检查 export 排除、integration NOT RUN、unit summary 不声明 integration coverage 三条原文证据。

| 阶段 | off 组工具观察中的三条逐字证据 | on 组工具观察中的三条逐字证据 | 此前 assistant 回答 |
|---|---|---|---|
| R3：首次复核 | 3/3，全文 | 3/3，receipt | 两组都已记录相关覆盖限制 |
| R4：第二次复核 | 0/3，OP 占位 | 3/3，receipt | 两组仍保留此前对覆盖限制的回答 |

三个配对轨迹相同。程序对历史回答只作 export/integration/not run/excl 词项检查；另外实际读取 pair-1-off 回答，确认 R2 已正确说明 integration 未运行、export worker 被排除，R3 又完整列出。这不是对所有回答的自动语义证明；六个最终 NO-GO 沿用原验证报告。

FACT：EPR 在 R4 提供了 OP 占位不再直接呈现的逐字证据。INFERENCE：这可能降低后续只依赖 assistant 转述的风险。UNKNOWN：是否降低真实误判、遗漏和返工。当前实验在 EPR 生效之前，主模型已经读过全文并形成正确判断，因此更像“正确结论的后续保持”验证，不能证明它能发现先前漏掉的关键证据。

### 9.2 通用诊断选证不是任务完整性审查

源码 FACT：reducerInput 只有 command hash、source hash、大小/行数、is_error、日志；completeSimple 不带用户问题或完整会话。指令偏向首个疑似因果错误、独特失败、失败目标与警告，最多 12 项、每项最多 600 字符。来源：src/upstream/sol-pi/evidence-preserving-reducer/receipt.ts:37–64、config.ts:14–19、src/omp/reducer-provider.ts:69–75。

因此不能保证 receipt 覆盖后续任意问题所需的配置、目标、数量或对比信息。原文存在只保证可以恢复，不保证主模型意识到需要恢复并实际读取。这也不直接意味着应该向辅助模型发送完整会话；那会扩大外发与隐私范围。

### 9.3 生产校验器的无模型边界探针

直接调用当前 validateReceipt，使用纯内存 ArchiveObject 和自造五行日志：一条 PASS、alpha/beta 两个独立 ERROR、一条 integration NOT RUN、一条两目标失败的 SUMMARY。source hash/status 正确。不调用 archiveBody 或 provider，不把构造输入冒充模型自然输出。

| 构造 receipt | 实际校验结果 | 未保留内容 |
|---|---|---|
| 只引用真实 alpha ERROR，kind=failure | accepted=true | beta ERROR、integration NOT RUN |
| 只引用真实 PASS 行，但标为 kind=failure | accepted=true | 两个 ERROR、integration NOT RUN |

两个探针中的 quote 均确实存在于原文。进程 exit 0；providerCalls=0、archiveFilesWritten=0。这是成功复现校验边界，不是质量验收 PASS。

FACT：当前校验器可以接受真实但不完整的证据，失败标签不构成语义验证。UNKNOWN：辅助模型自然产生这类响应的概率。探针只覆盖生产 validateReceipt，不覆盖完整 EPR 投影链路。来源：receipt.ts:81–142；本节记录直接运行结果。

### 9.4 实验 A：真实 OMP runner 的超时与取消分离

独立 Bun 进程直接导入固定版 ExtensionRunner，保留默认 EXTENSION_HANDLER_TIMEOUT_MS=30000，不使用测试接口修改 timeout。注册单个 session_stop 探针 handler：等待 35000ms，仅在 event.signal 取消时提前结束。通过公开 emitSessionStop 走真实 runner 超时路径。session/model registry 使用不调用认证或模型的最小内存依赖；不创建真实会话或认证存储，不是完整 CLI/provider 端到端测试。

通过公开 logger.setTransports({console:true,file:false}) 仅在探针进程输出控制台，避免创建/轮换用户日志文件；不修改用户配置。fetch 在该进程被设为拒绝并计数，networkAttempts=0；没有构造 provider 请求。对照组在 100ms 主动取消父 signal。

| 场景 | runner 返回时间 | 返回时工作仍活动 | 返回时父 signal 已取消 | 工作实际结束时间 |
|---|---:|---|---|---:|
| 工作等待 35s，宿主默认 30s timeout | 30008.206 ms | true | false | 35005.465 ms |
| 100ms 主动取消父 signal | 102.296 ms | false | true | 102.242 ms |

第一项实际记录 handler timed out after 30000ms；event.signal 与传入父 signal 是同一对象，工作未收到 abort，约五秒后自然结束。对照项收到 abort 并结束。全部工作 drain 后 active=false；进程 exit 0；总墙钟约 35.88s。

判定：边界复现 PASS；“宿主结束等待时异步工作必已取消”的安全验收 FAIL。原先“宿主超时不会自动取消 event.signal 下的工作”由源码推断升级为真实 runner 层实测 FACT。

结合本地 reducer-provider.ts:49–58、evidence-preserving-reducer.ts:109–153,210–212，仅靠 event.signal 加每请求 90s deadline，不能保证整个 settle 队列在宿主 30s 等待预算内完成。原来短时 RPC abort 验证仍有效，但不覆盖 runner 自身 timeout。

UNKNOWN：真实慢 provider 是否曾在用户会话触发、超时后计费、下一 prompt/abort 的具体调度。不能把本组三次约两秒的辅助请求倒推为失败。源码依据：OMP runner.ts:86–120,249–315,1275–1312；agent-session.ts:4110–4138，均为前文固定官方版本及本地对应文件。

### 9.5 按用户优先级重排结论

1. 先确保整个 settle 的生命周期可靠，不只缩短单个请求 timeout。本轮没有实施修复。
2. 质量底线先于压缩率：不能因 receipt 合法就认为遗漏项不存在；评估关键证据是否保留、发现、必要时回读，以及最终任务是否正确完成。
3. 区分基线：相对全文，EPR 没有增加原始信息；相对 OP 占位，它可能增加直接可见的精选原文证据。两种收益主张不能混用。
4. 首次全文未必是应消除的缺陷。质量优先时，让强主模型先读全文、后续保留精简证据，可能比首次完全依赖辅助选证更稳妥；这仍是待验证的取舍。
5. 时间按达到正确结果计算，计入回读、错误修改、返工、验证和 settle。原生融合的既有时间收益与 EPR 分开报告。
6. 费用最后优化，不因 receipt 比 OP 占位稍大就拒绝关键证据。经济性门槛不能替代质量验收。

下一项真实模型实验应优先检验“延迟问题所需证据是否被保留或正确回读”，而不是再问已回答过的同一覆盖问题。预先定义必需事实和最终任务判定，允许正常回读，不人为清空历史制造 EPR 优势；初次回答已完全解决后续问题的样本标为不能区分增益。分别记录 EPR 输入前缺失、摘要未保留、未回读和最终误判。该实验尚未确定最终调用预算或执行；新增真实模型请求仍须先说明并取得确认。

## 10. 可靠性补充验收（已完成，整体未通过）

用户要求继续测试并取得可靠结果。此次先执行不调用模型的既有回归测试及真实 receipt 离线校验；不修改源码、配置或依赖。新的真实模型实验尚未获得具体调用与预算确认，不执行。验收分开记录：引用与归档完整性、任务关键证据覆盖、生命周期等待/取消。已有 runner 超时反例不会因其他测试通过而改记安全 PASS。

### 10.1 既有隔离回归

执行命令（cwd=sol-omp）：

```sh
bun test tests/reducer.test.ts tests/reducer-receipt.test.ts tests/observation-pack.test.ts
```

实际结果：43 pass / 0 fail，3 files，Bun 显示 523ms，命令墙钟约 0.57s，exit 0。测试使用注入的 provider 响应及临时目录；没有真实模型请求。覆盖失败回退、逐字引用/状态/hash、归档破坏/符号链接、主动取消、去重、唯一 eval 关联、跨 session/重启和 OP 组合等现有契约。这不是完整 CLI/provider 验收，不覆盖第 9 节已复现的 runner 超时失配，也不证明任务级证据完整。初次定位误用了不存在的 evidence-preserving-reducer.test.ts；读取实际目录后改为上述文件，未将路径查找错误当作测试结果。

### 10.2 真实历史 receipt 的链路边界实验

与第 9 节只运行 validateReceipt 不同，本轮读取三个真实 on 配对对应的归档及已记录 verified.evidence。先验证源 hash，再把历史 evidence 重建为 provider 输出 JSON，通过构造器的 invoke 注入点送入当前生产 EvidencePreservingReducer。运行真实 observe → settle → archiveBody → validateReceipt → project → ObservationPack.project，每种状态重复投影四次。使用临时 sessionContext，而非真实 OMP CLI；未调用 completeSimple 或任何真实 provider。

每个样本三种条件，共 9 个案例：

| 条件 | 三个样本结果 | 质量意义 |
|---|---|---|
| 历史 evidence 对照 | 3/3 形成 receipt；NOT RUN 可见；原 session 消息不变 | 已有有效 evidence 能沿本地链路保留 |
| 删除含 NOT RUN 和 no claim about integration 的 evidence 条目，其余原样 | 3/3 仍形成 receipt；NOT RUN 不再直接可见；没有 fallback | 真实引用的任务关键遗漏可以穿过整个本地归约/投影/OP链路 |
| 将首条引用改成源中不存在的通过声明 | 3/3 拒绝，fallback=unverifiable-quote；四次投影后仍为完整源文本 | 编造引用被拦截，且 OP 不会再压缩回退原文 |

九个案例原始消息均保持不变，每个只调用一次注入函数；没有模型调用。临时归档由 mkdtemp 创建并在 finally 中删除，没有改动历史归档或用户配置。命令 exit 0，墙钟约 0.40s。

这是边界实验按预期完成，不是九项业务质量 PASS。删除 evidence 是人为注入，不能作为模型自然遗漏率或真实任务失败率；但已把“完整性校验缺失”的证据从单函数层推进到本地归档、receipt 投影及 OP 组合链路。当前要求的是“正确拒绝伪造”时 PASS；若要求“所有任务关键遗漏都被自动拒绝或触发回读”，则该要求不成立。

### 10.3 本轮可靠性判定

- 原文保留、可核对引用、明确非法引用回退：在本轮覆盖范围内 PASS。
- 主动父取消与去重：既有回归 PASS；不替代宿主自身 handler 超时。
- 宿主等待与辅助工作取消一致：第 9 节实测安全 FAIL，未修改实现，不重跑掩盖问题。
- 任务关键遗漏自动识别/阻止：链路实验显示不能保证；不得将 receipt 合法视作任务证据完整。
- 真实业务任务正确率/返工率、必要回读是否实际执行：NOT_RUN；没有具体新模型预算授权。
- 安全审计：此前 3 项 high 仍未解决，维持 FAIL。

结论：已获得可复查的可靠性边界结果，但当前系统不满足“可无条件信任 receipt 完整性且生命周期边界可靠”的总体验收。继续增加相同短日志样本不能消除已存在反例。下一阶段应先明确并修复整个 settle 的预算/取消问题；对证据完整性选择可验证的任务级验收与必要回读策略，而不是放宽校验或默认信任摘要。源码修复、设置变更及新增真实模型请求均未在本轮执行。

## 11. 累计验证统计与下一阶段授权边界

统计范围仅为第 9–10 节新增的无模型测试，不含历史真实模型基准，也不含本次分析会话自身的模型用量。

| 层次 | 案例数 | 结果 |
|---|---:|---|
| 既有隔离回归 | 43 | 43 pass / 0 fail；不覆盖任务级完整性或 runner 自身 timeout |
| 生产 validateReceipt 边界 | 2 | 不完整引用及错误分类均被接受；不是质量 PASS |
| 真实 runner 边界及父取消对照 | 2 | 宿主 timeout 后工作仍活动；主动父取消正常 |
| 历史原文与 receipt 的本地链路 | 9 | 3 正常对照成功；3 删除关键 evidence 后仍接受；3 编造引用被拒绝 |
| 合计 | 56 | 仅为执行案例数量，不能计算总体可靠率或模型自然错误率 |

上述各层使用不同条件，且部分基于同一批原文，不是 56 个独立业务任务。新增真实前台/Reducer 请求 0；新增这类验证请求费用 0，不代表分析聊天或此前验证累计费用为零。

当前功能状态：OP 核心已适配；EPR 核心链已适配但与上游时序不等价；sol-omp Action Fusion 未实现，原生 eval 仅提供部分替代；Online Context Compact 未移植。总体可靠性尚未通过；安全审计仍 FAIL。

继续工作的首要阻塞是“整个 settle 的预算/取消可靠性”。明确反例已存在，不再重复同一路径来增加通过数量。原始授权要求不改源码/配置/依赖；进入修复阶段前须取得源码修改授权。拟限定于 EPR 生命周期及对应回归，保持现有功能开启、不修改 OMP core/用户配置/依赖，不新增真实模型请求；修复后用宿主预算边界和多候选累计场景验收。证据完整性是另一项独立验收，不能因生命周期修复而记为解决。

## 12. 经授权的限定生命周期修复

用户通过确认授权限定源码修复；原先“仅分析”的约束在此范围解除。未改 OMP core、用户配置或依赖，未关闭功能，没有真实模型请求。

实现：settle 为整个候选队列建立共享 AbortController，预算为 min(25000ms, evidencePreservingReducerTimeoutMs)，保留距固定宿主 30000ms handler 预算的 5 秒余量。此前 90000ms 配置仍合法，但不再允许整个 settle 等待 90 秒。父取消转发；请求与认证收到共享 signal；await 请求的取消完成，不用 Promise.race 留下未结束请求。每个异步归档后及接受 receipt 前检查取消/绝对截止时间。预算耗尽记录 settle-timeout，迟到 receipt 不接受，未处理候选保留原文并标 attempted，不在以后重复花费。

回归证据：新增多候选共享预算测试，修复前实际 0 pass/1 fail（未收到取消），修复后 reducer.test.ts 8 pass/0 fail。完整 bun test：60 pass/0 fail；bun run typecheck：PASS；bun run smoke：真实固定 OMP 加载/关闭 PASS，不是 MODEL_E2E。

真实 runner 集成探针：默认 30 秒宿主预算；当前生产 EPR、三个候选、注入的每项 20 秒可取消辅助工作。第一项完成并缓存 receipt；第二项被共享预算取消并等待清理；第三项没有启动。runner 返回 25031.892ms，calls=2，activeAtRunnerReturn=0，handlerTimeoutWarnings=0；第二/第三项原文保留；再次 settle 不增加 calls。使用临时归档并已清理；无模型请求。

限制：该结果证明遵守 AbortSignal 的辅助工作在已测环境中的等待/取消一致性，不能保证任意不响应取消的 provider、卡死 fsync 或被阻塞事件循环都能在 5 秒余量内退出。没有用抛弃 Promise 的方式掩盖这类风险。真实慢 provider/认证服务未发送请求验证。证据完整性问题仍独立存在；60 项回归通过不代表任务级摘要完整性通过。安全审计仍 FAIL，3 项 high 未解决。

工具记录：LSP references 初始化仍因根工作区 TypeScript 查找失败不可用，使用实际调用点检索补充；完整 tsc 通过。AST method 替换因解析问题未生效，读取未改变的源快照后完成修改；首次回归失败保留。现有运行中的 OMP 进程不会热加载此更改，需要正常重启后使用新实现，本轮未替用户重启。

## 13. 延迟问题质量验收预检（等待真实请求授权）

两份独立合成 npm 样本已创建于 /tmp/sol-omp-quality-68rGaj，没有业务数据。无模型执行结果：coverage exit 0、18971 bytes、242 lines；multiple-failures exit 7、18927 bytes、242 lines。两者 >4096 bytes 且 <20KiB；实际 OMP 工具是否先行截断仍必须在模型运行时检查，不能由源输出大小推定。

场景一：unit 237 passed，但 integration-checkout 未运行，export-worker 被排除；延迟问题要求判定完整覆盖。场景二：alpha/beta 两个失败目标，integration-gamma 未运行；延迟问题要求说明仅修复 alpha 后剩余问题。真实请求保持现有 EPR/OP 开启，不做 off 对照、不改变主模型/high、原生 eval/审批。每场景首次诊断、一个中间回合、一个延迟问题，允许正常只读恢复。首次回答已经完整回答延迟问题时标记为不能区分增益，不删除历史来制造难度。

质量 PASS：最终任务判断正确，必需事实齐全且能对应实际输入/归档；若 receipt 不足，观察是否正确回读。错误通过、遗漏必需事实、编造状态为 FAIL；输入先行截断、无 receipt 或证据轨迹不完整分别列明，不冒称证明 EPR 提升。两个场景通过也不构成一般正确率保证。这是 EPR-on 的任务可靠性验收，不是 on/off 因果收益估计。

计划新前台响应约 10–16 次、Reducer 2 次（回读及宿主重试可能改变数量，全部计入）。规划目录估算约 $0.30–5.00，包括辅助约 $0.001–0.004；不是实际 OAuth/Go 账单或硬上限。拟以 $5 记录估算作为停止预算，达到时不提交新提示并中止运行；已在途请求/缺失 usage 可能超出该记录。不得自动补样、重试实验或升级模型。需要用户明确授权后才发送第一条模型提示。


## 14. 经授权的两份真实模型任务质量结果

用户明确选择“执行两份样本”后执行。使用正常用户安装的 OMP 18.1.18，新进程加载修复后的独立扩展；主模型 openai-codex/gpt-6-astra/high，Reducer opencode-go/glm-5.3-flash。启动证据显示 OP=true、EPR enabled；没有修改用户配置、审批、插件、OMP core 或依赖，没有关闭原有功能。额外只读 context 探针观察送模工具消息；未打印认证、headers 或原始 provider payload。每个独立会话执行一次 npm test、一个无工具中间问题、一个延迟问题。没有追加模型样本、重跑实验或升级模型。

### 14.1 质量判分与证据流

| 样本 | 首次工具消息 → receipt | 最终质量判分 | 归因/限制 |
|---|---|---|---|
| coverage | 18996 → 1498 bytes，真实辅助响应通过引用校验 | PASS：明确不能称 fully tested；integration-checkout NOT RUN、export-worker excluded，引用对应原文行；unit 237 passed 没有被泛化 | 首次回答已包含全部目标状态，不能区分 EPR 对正确性的增益 |
| multiple-failures | 12584 → 1312 bytes，真实辅助响应通过引用校验 | 完整任务验收 FAIL：未能找回 beta 实际失败；安全表述 PASS：明确 beta unknown，不把缺失判为通过；gamma NOT RUN 正确 | 输入 EPR 前已含 […82ln elided…]，beta 在首次主模型上下文及归档中均不存在；不是 EPR 将 beta 从完整输入删掉的证据 |

multiple-failures 合成源明确含 ERROR target beta FAILED: expected 8, got 9，但实际归档没有此行。最终模型主动调用原生 eval 内的 read，再调用 grep 定位 beta/integration-gamma/FAILED/NOT RUN/exited；未重跑测试、未修改文件。read 的对象 display 又形成 8039-byte 截断观察，随后 grep 观察 2940 bytes；即使避免这次显示截断，也无法恢复归档之前已丢失的 beta。最终答复：beta 仍无法确定，gamma 因外部服务未验证，原运行 exit 7；修好 alpha 不能宣称全部通过。

这证明“发现不确定并回读”在该样本确实发生，但“归档总能恢复完整诊断”不成立。不能把该样本算作 EPR 模型自然漏选，也不能用合法 receipt 将端到端完整性 FAIL 改记 PASS。没有 off 对照，不计算 EPR 正确率提升；两例不是业务可靠率统计。

### 14.2 调用、时间与费用（仅本轮实验）

| 项目 | coverage | multiple-failures | 合计 |
|---|---:|---:|---:|
| 记录到的前台完成响应 | 4 | 6 | 10 |
| 真实 Reducer request/response/verified | 1/1/1 | 1/1/1 | 2/2/2 |
| 前台 totalTokens | 49485 | 76838 | 126323 |
| Reducer totalTokens | 4124 | 2861 | 6985 |
| 前台目录费用估算 USD | 0.304018 | 0.293772 | 0.597790 |
| Reducer 日志目录费用估算 USD | 0.000343075 | 0.000236800 | 0.000579875 |
| 三次提示至 agent_end 累计秒数（含 settle） | 28.293 | 45.195 | 73.488 |
| Reducer response duration 秒数（已含在上行，不能再相加） | 2.359 | 2.135 | 4.494 |

记录费用合计 $0.598369875，未触发 $5 记录停止预算；整个驱动命令墙钟 80.99 秒，包含两个进程启动等开销。两次辅助 usageComplete=true。若按第 8 节已核实的促销后辅助单价重算辅助费用，辅助为 $0.001159750，总计约 $0.598949750。主模型 OAuth 与 Go 订阅实际账单仍不是这些目录乘积。

这里统计的是可观察到的完成响应与 EPR 日志，不是网络抓包：未独立计量 SDK 内部传输重试、宿主其他后台请求或无 usage 的失败请求；不可声称已审计全部真实计费用量。所有已记录调用均纳入，没有隐藏失败补样。本分析会话自身用量不在表内。

### 14.3 可复核证据与操作失败记录

私有临时证据根目录：/tmp/sol-omp-quality-68rGaj；每场景 quality-results.json 保留白名单用量、最终答案、阶段耗时和 context 工具观察；sessions 保留正常宿主会话及 EPR 归档。临时目录不是长期持久存储。

- coverage 归档：18996 bytes，SHA-256 6ffcd159c931c8e27861d8c4d0c17895b2db6382fdb8a5d8b6cbc7b961afe6fb；无 elision marker。
- multiple-failures 归档：12584 bytes，SHA-256 cea9af42eecb0bc8b8b5150e673b5ed1390f312c193a5460a94e65f07808750a；有 elision marker，无 beta 失败行。
- 临时驱动初次生成有换行转义 SyntaxError；第一次修正读取了被工具缩略的长提示行，又出现 SyntaxError。两次都在 Python 解析阶段退出，未启动 OMP、未发送模型请求；恢复完整提示并分行后才启动上述唯一一轮模型实验。没有将准备失败隐藏为一次成功运行。

### 14.4 当前结论与后续范围

限定生命周期修复已有第 12 节验证；本轮两次真实辅助正常完成，不能代替真实慢 provider 取消实验。当前整体仍未达到“完整且可靠找出所有剩余问题”的验收：主要新证据是失败诊断在 EPR 前截断，归档/回读无法补回。下一项修复应首先定位原生 bash → eval 的失败输出截断与完整源引用，保证被省略内容有可恢复来源；不应先更换 Reducer、加样本、降低质量标准或默认接受 receipt。该链路修复可能超出已授权的 EPR 生命周期范围，本轮未修改，须另行界定授权。安全审计仍 FAIL，原 3 项 high 未解决。

## 15. 原生截断定位、Artifact 完整源恢复修复与无模型宿主验证

### 15.1 失败输出截断链路的精确定位

复用 `/tmp/sol-omp-quality-68rGaj/multiple-failures` 的真实合成样本（合成源码 exit 7、242 行、18927 字节；`beta` 失败位于第 121 行）及 OMP 18.1.18 源码，定位整条链路中各节点的真实状态：

1. **原生 bash 返回截断（首次截断发生点）**：
   - 代码位置：OMP `src/exec/bash-executor.ts:510-530`、`src/session/streaming-output.ts:1336-1352`（`OutputSink.dump()`）及 `src/tools/bash.ts:818-857`（`buildCompletedResult` 调用 `enforceInlineByteCap`）。
   - 机制：`executeBash` 创建 `OutputSink`，当流式输出超过 `spillThreshold`（默认约 8–10KiB）时，`OutputSink` 同步向会话 artifact 文件（`sessions/<sessionId>/<id>.bash-original.log`）完整写入原始无损流（242 行、18927 字节）；但在内存 ring buffer 中执行了 middle elision，将第 81 至 162 行替换为 `[…82ln elided…]`，`beta` 失败恰好落入该区间被剔除。随后 `bash.ts` 附加耗时与退出码，并由 `enforceInlineByteCap` 附加 `[raw output: artifact://2]` 页脚。
   - 结论：**bash 工具返回的 `AgentToolResult.content` 本身就已经是截断文本（12584 字节），这是整条链路上截断的首次发生位置。**

2. **eval display 截断**：
   - 代码位置：OMP `src/eval/js/tool-bridge.ts:247-254`（`callSessionTool("bash", ...)`）及 `src/tools/eval.ts:820-827`。
   - 机制：模型在 eval 中执行 `const r = await tool.bash(...); display(r.text);`。eval 的工具桥调用 `bash.execute`，接收到的是上述已截断的 `cappedOutputText`。eval 的 `display` 仅将 `r.text` 收集进 display 输出，eval 本身在此处并未施加额外的 middle elision 截断，仅是对 bash 截断结果的原样转发。

3. **扩展接收内容（Extension Observation）**：
   - 代码位置：OMP `src/extensibility/extensions/wrapper.ts:371-385`（`ExtensionToolWrapper.execute`）。
   - 机制：bash 执行完毕后触发 `tool_result` 事件。扩展在 `event.content` 中接收到的确是被截断的 12584 字节，但同时在 `event.details.meta.truncation` 中接收到了完整的截断元数据（含 `direction: "middle"`、`artifactId: "2"`、`elidedLines: 82` 等），且在 `event.content` 文本中包含 `[raw output: artifact://2]`。

4. **EPR 归档内容（错误引入点）**：
   - 代码位置：`sol-omp/src/omp/evidence-preserving-reducer.ts:81-100` 及 `src/upstream/sol-pi/evidence-preserving-reducer/candidate.ts:25-34`。
   - 机制：旧实现中 `reducibleToolResult` 直接提取 `event.content` 作为 `body`，完全忽略了 `details.meta.truncation` 和 `artifact://` 引用。EPR 误将已经截断的 12584 字节预览文本当作完整源（`sourceSha256: cea9...`、`sourceBytes: 12584`、`sourceLines: 168`），直接发送给 Reducer 模型并归档至 `evidence-preserving-reducer/objects/ce/cea9...txt`。
   - 结论：**EPR 归档不仅丢失了 beta，还将包含 `[…82ln elided…]` 的预览碎片当作了“完整原文”。主模型后续回读该归档时自然无法找回 beta。**

### 15.2 可恢复来源与 OMP 公开接口分析

1. **可恢复来源存在且无损**：
   - OMP 在执行大型输出时，`OutputSink` 将原始未经截断、未受列限制削减的完整字节流同步写入了磁盘会话 artifact（命名规则 `<artifactId>.<toolType>.log`，如 `2.bash-original.log`）。该文件包含完整的 242 行、18927 字节，第 121 行 `ERROR target beta FAILED: expected 8, got 9` 完整存在。
2. **OMP 公开扩展接口**：
   - `ExtensionContext.sessionManager` 暴露了公开方法 `getArtifactPath(id: string): Promise<string | null>` 以及 `getArtifactsDir(): string | null`。
   - `ExtensionAPI` 在 `tool_result` 和 `session_stop` 事件中完整传递了 `ctx: ExtensionContext`。
3. **严苛的恢复与不可用判定准则**：
   - 只有当成功读取到 artifact 且该文件本身不含 `[…elided…]` 或 `[ARTIFACT TRUNCATED:` 标记时，才认定为完整恢复。
   - 当 artifact 文件不存在、读取失败或文件本身再次截断时，坚决不把截断内容冒称完整原文，明确标记候选失败原因为 `incomplete-truncated-source`，保留带有省略标记的原始会话消息，绝不生成虚假 receipt。

### 15.3 独立 sol-omp 扩展内的限定修复

所有修改均严格限制在独立扩展 `sol-omp` 内，零修改 OMP core、零修改上游 Pi、零修改 node_modules 及依赖配置。

1. **候选状态模型解耦（完整源 vs 会话观察）**：
   - `Candidate` 区分 `body`（完整源，用于 archive 存储、Reducer 模型输入及 quote 行号校验）与 `observedBody`（会话消息中的实际文本，用于 `project` 中的精确替换）。
2. **截断识别与 Artifact 恢复机制**：
   - 新增 `detectTruncation`：结合 `event.details.meta.truncation`、`[raw output: artifact://<id>]` 标记及 elision 正则，准确提取 `artifactId` 和截断状态。
   - 新增 `isValidFullArtifact`：严格检验读取的内容非空且未受二次截断污染。
   - 新增 `resolveArtifactContent`：通过 `ctx.sessionManager.getArtifactPath` 并以 `getArtifactsDir` 为回退，安全异步读取完整 artifact。
3. **双重保障恢复时序**：
   - 在 `observe` 事件触发时，若具备 `ctx` 则立即异步解析 artifact；
   - 在 `session_stop` 的 `settleBeforeDeadline` 执行前，针对仍未恢复的截断候选，利用 `ctx` 进行二次尝试；若仍不可达，标记 `fallback = "incomplete-truncated-source"`。
4. **替换与归档逻辑闭环**：
   - `replaceBody(projected, candidate.observedBody, candidate.receipt)`：在会话消息中准确寻找并替换截断片段，保持会话消息上下文收敛。
   - `archiveBody(storeRoot, candidate.body)`：归档完整无损的源内容，使 receipt 中注明的 `source_artifact` 指向真正包含全部原始行的对象。
   - 保持工具原有退出码（`isError: true`）、错误状态及审批语义完全不变。

### 15.4 无模型真实宿主与单元验证证据

1. **单元与回归测试**：
   - 运行 `bun test`：**64 pass / 0 fail**（耗时 1061ms），覆盖率与全部 60 项已有测试零退化。
   - 新增针对性测试用例：
     * `large truncated bash output with failure in middle elision recovers beta from session artifact`：验证非零退出码大输出、中间区域 beta 失败被准确归档与引用，退出状态保持 `isError: true`，`source_artifact` 实际读出完整 beta。
     * `eval envelope containing truncated bash output recovers middle failures from artifact`：验证 eval 包装场景下的完整源恢复与 receipt 替换。
     * `truncated output with unavailable artifact marks incomplete-truncated-source fallback and retains original`：验证 artifact 不可用时 fallback 为 `incomplete-truncated-source`，不调用模型、不冒充完整，保留原始消息。
     * `corrupted or elided artifact file is rejected and falls back`：验证被二次截断的 artifact 文件被正确拒绝。
   - 类型检查：`bun run typecheck`（`tsc --noEmit`）**PASS**。
2. **真实历史合成样本 Replay 验证**：
   - 读取 `/tmp/sol-omp-quality-68rGaj/multiple-failures` 会话 message 9 及对应的 `2.bash-original.log`。
   - 运行结果：
     * 恢复后的模型输入大小：18927 bytes、243 lines。
     * 包含完整的第 121 行 `ERROR target beta FAILED: expected 8, got 9`。
     * 生成并投影包含 `status=failure` 和 beta 引用的合法 receipt。
     * 生成的 `source_artifact` 文件大小为 18927 字节，不含 `[…82ln elided…]`，beta 实际可读。
3. **OMP 真实宿主加载烟测**：
   - 运行 `bun scripts/smoke.ts`：通过 real OMP 18.1.18 CLI 在 RPC 模式下加载运行并正常关闭，输出 `SMOKE=PASS`。

### 15.5 本轮判定与剩余边界

| 检查项 | 状态 | 说明 |
|---|---|---|
| 原生链路截断位置精确定位 | **PASS** | 明确为 `bash.ts` / `OutputSink` 首次截断，eval 原样转发，EPR 归档误将截断体当作完整源 |
| 完整内容可恢复来源及公开 API | **PASS** | `ctx.sessionManager.getArtifactPath` 可达无损 `.bash-original.log` |
| 独立 sol-omp 扩展内限定修复 | **PASS** | 候选解耦完整源与观察体，增加双重恢复与严格不可用回退，未动 core |
| 错误状态与审批语义保持 | **PASS** | `isError: true` 及 exitCode 保持不变，无重跑命令 |
| 无模型宿主/合成场景验证 | **PASS** | 64 项回归通过，真实合成 Replay 18927 字节与 beta 完整恢复，烟测通过 |
| 不可用时标记不完整 | **PASS** | artifact 缺失或受污染时明确 fallback `incomplete-truncated-source`，保留原文 |
| 真实模型端到端复验 | **PENDING** | 等待用户明确批准后按新预算执行，本轮未发起任何模型调用 |
| 依赖安全审计 | **FAIL** | 3 项既有 high 依赖安全问题根据约束本轮未升级依赖，维持原判 |

### 15.6 针对该断点的真实模型复验方案与预算申请

在本地逻辑已经验证闭环的前提下，为验证在真实模型推理端到端场景下，主模型是否能够在收到 receipt 后通过 `read(source_artifact)` 正确找回此前缺失的 `beta` 诊断并给出完整结论，提出如下复验方案（等待用户明确批准）：

1. **复验环境与参数**：
   - 复用 `/tmp/sol-omp-quality-68rGaj/multiple-failures` 样本结构（或在同等干净临时目录重建）。
   - 主模型：`openai-codex/gpt-6-astra`（thinkingLevel: high）。
   - Reducer 模型：`opencode-go/glm-5.3-flash`。
   - 扩展加载：加载包含上述 Artifact 恢复修复的 `sol-omp` 独立扩展。
2. **测试提示流程（单场景）**：
   - 步骤 1：执行测试命令并获取结果（触发 EPR 恢复、生成包含 `source_artifact` 和 `beta` 的 receipt）。
   - 步骤 2：提问延迟诊断问题：“What remains unresolved if only target alpha is fixed? Account for target beta and integration-gamma, using the existing diagnostic evidence or its recorded source.”
   - 观察主模型是否能够正确指出 beta 失败，或通过读取 `source_artifact` 确认 beta 实际失败状态，实现端到端任务完整性 PASS。
3. **请求次数与费用停止预算**：
   - 仅针对 `multiple-failures` 这一处断点进行 1 个完整场景验证。
   - 前台模型请求次数：约 3–5 次（含工具调用与回读）。
   - Reducer 模型请求次数：1 次。
   - 停止预算（Stop Budget）：设置记录费用上限为 **$1.50 USD**（前台预计消耗约 $0.30–0.40，Reducer 预计消耗约 $0.0003）。若单次实验记录费用达到 $1.50 则立即中止，不再提交新提示。
   - 严禁自动补样、严禁跨样本重试、严禁超出预算。

本方案必须在获得用户明确批准后方可执行。

## 16. 经授权的真实模型断点复验结果（端到端完整性 PASS）

### 16.1 执行概况与费用开销

在用户明确指示“同意”后，执行了 15.6 节申请的真实模型断点复验。启动新 OMP 18.1.18 headless 进程，在干净隔离目录 `/tmp/sol-omp-reverify-multiple-failures` 中重现 `multiple-failures` 样本，加载修复后的独立 `sol-omp` 扩展。

- 主模型：`openai-codex/gpt-6-astra`（thinkingLevel: high）；
- Reducer 模型：`opencode-go/glm-5.3-flash`；
- 费用停止预算：$1.50 USD；
- **实际总记录费用**：**$0.1001 USD**（仅消耗预算的 6.7%，未触发停止线）；
- 前台响应次数：3 次；前台 totalTokens: 48,258（input: 4,037, output: 317, cacheRead: 43,904）；
- Reducer 交互：1 次 request / 1 次 response / 1 次 verified（duration: 2283ms, tokens: 4,079, cost: $0.000332 USD）；
- 总耗时：约 43.7 秒。

### 16.2 证据流对比：修复前（截断致错） vs 修复后（Artifact 恢复）

| 指标 / 环节 | 修复前历史（第 14 节） | 修复后复验（本轮） | 结论与改善 |
|---|---|---|---|
| 原生 bash 输出 | 截断为 12584 bytes，含 `[…82ln elided…]` | 截断为 12584 bytes，含 `[…82ln elided…]` | 保持 OMP 原生行为不变 |
| OMP 磁盘 Artifact | 同步写入 `2.bash-original.log`（18927 bytes） | 同步写入 `2.bash-original.log`（18960 bytes） | 完整源始终存在于磁盘 |
| EPR 候选源读取 | 忽略 artifact，直接取截断的 12584 bytes | 通过 `getArtifactPath` 读取完整 18960 bytes | 完整源成功恢复并纠正 |
| Reducer 输入及归档 | 12584 bytes，归档自身含 `[…82ln elided…]` | 18960 bytes（242 行），归档无任何 elision | 彻底消除虚假归档 |
| Reducer 验证证据 | 仅发现 alpha、gamma，**beta 彻底缺失** | **成功验证 alpha(43行)、beta(123行)、gamma(203行)** | 完整捕获全部 3 项状态 |
| Receipt 生成与投影 | `source_bytes=12584`，丢失关键失败 | `source_bytes=18960`，完整注明 beta 与 gamma | 凭证信息真实完整 |
| 延迟提问（Turn 3）答复 | **FAIL**：“Beta remains unaccounted for. The recorded source itself contains an `[…82ln elided…]` gap…” | **PASS**：“Fixing `alpha` alone leaves two unresolved targets: **`beta` still failed:** recorded diagnostic line 123 says `ERROR target beta FAILED: expected 8, got 9`; **`integration-gamma` remains unverified:** line 203 says `TARGET integration-gamma: NOT RUN; requires external service`.” | 准确说出 beta 事实与具体行号，无遗漏无幻觉 |

### 16.3 最终判定矩阵（全阶段汇总）

| 验收维度 | 最终判定 | 证据与结论 |
|---|---|---|
| settle 生命周期可靠性 | **PASS** | 共享预算与级联取消闭环，5s 余量，多候选测试与宿主边界验证通过 |
| 原生截断定位与 Artifact 恢复 | **PASS** | 定位 bash 首次截断；`sol-omp` 独立实现无损 artifact 提取与二次截断校验，零修改 OMP core |
| 来源缺失严格回退 | **PASS** | artifact 缺失或受污染时明确 fallback `incomplete-truncated-source`，绝不冒充完整原文 |
| 端到端任务完整性质量 | **PASS** | 延迟问题中主模型准确识别此前因截断丢失的 `beta` 失败并准确定位第 123 行；coverage 与 multiple-failures 均达标 |
| 依赖安全状态 | **FAIL** | 3 项 high 依赖安全漏洞仍未解决（受约束限制本次未升级依赖，继续作为遗留问题跟踪） |

### 16.4 交付物总结

1. **代码修改范围**（仅限 `sol-omp` 扩展内部）：
   - `src/omp/evidence-preserving-reducer.ts`：解耦 `Candidate.body` 与 `Candidate.observedBody`；新增 `detectTruncation`、`isValidFullArtifact`、`resolveArtifactContent`；实现 observe 与 settle 双重恢复机制及不完整源 fallback。
   - `tests/helpers.ts`：支持测试桩自定义 `sessionManager` 模拟接口。
   - `tests/reducer.test.ts`：新增 4 项单元测试，包括非零退出截断恢复、eval 嵌套包装、artifact 不可用回退、损坏 artifact 拦截。
2. **测试验证数据**：
   - 本地单元/回归测试：`bun test` 全部 64 项测试通过（0 失败）；
   - 静态类型检查：`bun run typecheck` 0 错误；
   - 真实宿主烟测：`bun scripts/smoke.ts` 在固定 OMP 18.1.18 环境下 PASS；
   - 真实模型端到端质量复验：耗资 $0.1001 USD，主模型精准指出 beta 失败并附带行号，任务完整性 PASS。

## 17. Artifact 恢复生命周期补修（2026-09-12）

用户授权“开始修复”后，限定修改独立扩展及对应回归。未修改 OMP core、用户配置、依赖或原版 Pi，没有发起真实模型验证请求。第 15–16 节保留为历史实现与实验记录；本节取代其中 observe/settle 双重恢复的当前实现说明，不将历史单场景 PASS 扩大为无条件可靠性保证。

### 17.1 根因与实现

- 旧 observe 可返回异步 Artifact 恢复 Promise，但 tool_result 注册包装未返回或等待它。现在 observe(event, root) 只同步收集候选，删除 ctx 参数及异步分支；全部调用点迁移。恢复只在带真实父 signal、共享绝对截止时间的 settle 中执行，不在无 signal 的 tool_result 上添加另一个异步等待。
- 旧 settle 在检查取消和设置 attempted 前先恢复源。现在候选在首次 await 前被认领，取消/截止时间检查先于恢复；并发 settle 不重复启动同一候选的恢复及辅助调用。
- resolveArtifactContent 接收共享 signal 和 deadline。路径查询、目录查询/枚举、读取前后检查预算；readFile 使用该 signal。过期或取消后不启动目录回退读取、后续候选恢复或辅助请求；不接受迟到源内容，保留原始消息并记录取消/超时，之后不重试。
- 来源缺失/仍截断、秘密、大小及失败状态准入仍严格回退；统一在 settle 检查恢复后的源。保留完整源与 observedBody 分离、精确 eval 关联、原始消息不变以及 receipt/OP 组合约束。

### 17.2 本轮验证

| 验证 | 实际结果及范围 |
|---|---|
| 三项新边界回归，修复前 | 0 pass / 3 fail：tool_result 已启动恢复、已取消 settle 仍查询两个候选、到期后仍查询后续候选 |
| 修复后专用 reducer 回归（增加并发恢复测试前） | 15 pass / 0 fail |
| 最终完整 bun test | 68 pass / 0 fail，5 files，1.118 秒；新增四项覆盖同步收集、预取消、到期 drain/停止后续 I/O、并发恢复去重；既有 beta 恢复、eval 包装及不完整源回退仍通过 |
| bun run typecheck | PASS，tsc --noEmit；observe 调用点已迁移 |
| bun run smoke | PASS；真实 OMP 18.1.18、Bun 1.3.14，OP 开/关的隔离加载与关闭；不是 EPR 模型或慢 provider 端到端验证 |
| 注册事件路径内存烟测 | 生产注册 handler，注入 50ms 路径查询，配置 20ms 队列预算，两个候选；tool_result 零查询，settle 仅一次查询，返回时 active=0，两个原消息保留，再 settle 不重试；providerCalls=0、filesWritten=0。不是完整 OMP runner 集成测试 |

测试中的模型响应为注入数据，不计作真实模型质量复验。烟测及回归临时目录由既有 finally/清理钩子删除；内存烟测直接 bun -e 执行，没有留下脚本文件。LSP references 因工作区 TypeScript 初始化失败不可用，使用调用点检索与最终 tsc 补充，未安装或改动依赖。

### 17.3 保证边界

getArtifactPath 和目录枚举没有可传入的取消接口：已经启动的调用仍需 await 完成，不能保证卡死文件系统或不响应取消的 provider 在宿主 30 秒内退出。本修复保证已观察到取消/截止后不再启动下一步恢复，不用 Promise.race 抛弃未结束工作。证据完整性仍独立于引用合法性；本轮不重新判定任务级正确率，也未重跑历史真实模型实验。依赖安全审计未重跑，原 3 项 high 未解决，沿用 FAIL。运行中的 OMP 不由本轮重启，应正常重启后加载新实现。

