# muti-agent 多 Agent 协作框架 · 方案文档

版本:v1 草案 | 日期:2026-09-18 | 状态:待评审

---

## 1. 背景与目标

### 1.1 背景

本机已有两个成熟的 AI 编码 CLI:**Claude Code**(`claude` 2.1.x)和 **Codex CLI**(`codex` 0.155.x),均已完成登录授权,均支持 headless(非交互)调用。它们各自是完整的 Agent:自带模型推理、工具链(文件读写、shell)、权限控制。

CrewAI 等多 Agent 框架的核心价值不在 Agent 本身,而在**编排**:角色定义、任务分发、上下文共享、协作协议、终止控制。

### 1.2 目标

1. **复用而非重造**:以 `claude` / `codex` CLI 作为 Agent 执行体,不直接调 API,不重复实现工具链和权限体系。
2. **多 Agent 自主协作**:多个异构 Agent(claude 与 codex 混合)围绕一个任务进行多轮对话,能互相提问、反驳、补充,并自行判断收敛。
3. **通用框架**:角色、流程、终止条件由配置文件声明,场景(代码开发、方案评审、内容生产等)后定。

### 1.3 非目标(本期不做)

- 不做 GUI / Web 界面(纯 CLI)
- 不做分布式(单机多进程即可)
- 不做持久化记忆库 / RAG(对话记忆 = 当次运行的 transcript)
- 不接管 Agent 内部工具调度(工具链完全由 CLI 自身管理)

---

## 2. 方案选型(已决策)

| 方案 | 描述 | 结论 |
|---|---|---|
| **A. CLI 封装编排** | Node.js/TypeScript 编排器调用 `claude -p` / `codex exec` 子进程(Node ≥ 23.6 原生运行 TS,运行期零依赖) | ✅ **采用**。零额外授权配置,完整复用 CLI 能力,实现最简 |
| B. Agent SDK + Codex CLI 混合 | Claude 侧用 claude-agent-sdk(支持 session 续接),Codex 侧走 CLI | 备选。Claude 侧可获得真正的多轮记忆,但两种 Agent 能力不对称,复杂度上升 |
| C. 纯 API 编排 | 直接调 Anthropic / OpenAI API,自写 Agent 循环 | 放弃。违背"复用 CLI"目标,等于重造轮子 |

**方案 A 的关键含义**:每次 Agent 发言是一次**独立的、无状态的** CLI 调用。Agent 没有内部记忆,"记忆"由编排器以对话记录(transcript)形式注入每轮 prompt。这与 CrewAI 的共享上下文模型一致,也是本方案最核心的架构决策。

---

## 3. 总体架构

```
┌───────────────────────── 编排器 src/crew.ts ───────────────────────┐
│                                                                  │
│   配置加载 ──► 角色注入 ──► 轮次调度 ──► 终止判定 ──► 落盘        │
│                    │                                             │
│              共享对话记录(transcript)                            │
│                    │  每轮 prompt = 角色 + 协议 + 任务 + 历史      │
│        ┌───────────┼───────────┐                                 │
│        ▼           ▼           ▼                                 │
│   ┌─────────┐ ┌─────────┐ ┌─────────┐                            │
│   │ Agent A │ │ Agent B │ │ Agent C │   (逻辑实体:角色+backend)  │
│   └────┬────┘ └────┬────┘ └────┬────┘                            │
└────────┼───────────┼───────────┼─────────────────────────────────┘
         ▼           ▼           ▼
   claude -p    codex exec   claude -p      (进程实体:headless CLI)
  (子进程调用)  (子进程调用)  (子进程调用)
```

### 3.1 核心概念

| 概念 | 定义 | 对应 CrewAI |
|---|---|---|
| **Agent** | 逻辑实体 = 名称 + 角色(system prompt)+ backend(claude/codex)+ 调用参数 | Agent(role/backstory) |
| **Backend** | CLI 适配层:负责把"角色 + prompt"翻译成具体 CLI 调用并回收输出 | LLM provider |
| **Crew** | 一组 Agent + 一个任务 + 协作模式 + 终止参数,由 JSON 配置声明 | Crew |
| **Transcript** | 共享对话记录,编排器持有,每轮全量注入 | 共享上下文 |
| **Turn / Round** | 一个 Agent 发言一次为一 Turn;所有 Agent 各发言一次为一 Round | — |

### 3.2 模块划分

| 模块 | 职责 |
|---|---|
| `Agent` | 角色定义;按 backend 构造 CLI 命令;发起单次调用并返回文本;超时与失败处理 |
| `Backend 适配`(内嵌于 Agent) | claude:`-p --system-prompt`,prompt 经 stdin;codex:`exec --sandbox`,角色并入 prompt |
| `Crew / 编排器` | 加载配置、注入协作协议、按模式调度、判定终止、保存 transcript |
| CLI 入口 | `muti-agent run <config> [--task ...] [--max-rounds ...] [-o ...]`(package.json `bin` 全局安装) |

---

## 4. 协作模式

### 4.1 conversation:自主多轮对话(主模式)

**调度**:round-robin。每轮按配置顺序,各 Agent 依次收到"任务 + 完整 transcript + 轮到你了"的 prompt 并发言。

**协作协议**(注入每个 Agent 的 system prompt):

1. 发言要求简洁、有增量,不重复他人观点;
2. 可点名其他 Agent 提问、补充或反驳;
3. 本轮无新内容 → 只回复 `PASS`;
4. 认为任务完成/讨论收敛 → 发言后末行输出 `[END]`。

**终止条件(三重保险,防死循环)**:

| 条件 | 语义 |
|---|---|
| 任一 Agent 输出 `[END]` | 主动宣布收敛,立即结束 |
| 一整轮全员 `PASS` | 无人有新内容,自然结束 |
| 达到 `max_rounds` | 强制兜底 |

### 4.2 sequential:顺序流水线

按配置顺序每个 Agent 执行一次,可见此前所有环节的产出。适用于职责明确的线性流程(调研 → 编码 → 审查)。可通过配置同一个 Agent 出现多次 + 外部循环脚本实现"审查打回重做"。

### 4.3 演进方向(本期不实现)

- **Manager 调度**:引入一个 manager Agent 动态决定下一个发言者,替代 round-robin —— 更灵活但每轮多一次调用,成本翻倍;
- **选择性上下文**:只给 Agent 与其相关的历史片段,降低 token 消耗;
- **结构化产出**:要求 Agent 输出 JSON，编排器解析后路由(类似 CrewAI 的 task output 传递)。

---

## 5. 配置设计

```jsonc
{
  "name": "design-review",
  "mode": "conversation",       // conversation | sequential
  "max_rounds": 6,              // conversation 模式兜底轮数
  "task": "讨论的问题",          // 可被 CLI --task 覆盖
  "agents": [
    {
      "name": "architect",      // 对话中互相点名的标识
      "backend": "claude",      // claude | codex(可扩展)
      "role": "角色设定文本",    // 作为 system prompt 注入
      "model": null,            // 可选:覆盖 CLI 默认模型
      "skip_permissions": false,// true = 允许免确认使用工具(写文件/执行命令)
      "extra_args": [],         // 追加给 CLI 的原始参数(逃生舱)
      "timeout": 300            // 单次发言超时(秒)
    }
  ]
}
```

设计要点:

- **JSON 而非 YAML**:纯标准库可解析,零依赖;
- **`extra_args` 逃生舱**:不为每个 CLI 参数做建模,新参数直接透传;
- **`skip_permissions` 默认 false**:安全默认值,详见 §6。

---

## 6. 安全与权限模型

Agent 的"说"与"做"分离:

| 级别 | claude | codex | 适用 |
|---|---|---|---|
| **只读(默认)** | headless 下需确认的工具即不可用,只能输出文本 | `--sandbox read-only` | 讨论、评审、分析类 Agent |
| **可写** | `--dangerously-skip-permissions` | `--sandbox workspace-write` | 编码类 Agent,按需对单个 Agent 开启 |

原则:**默认只读,逐 Agent 显式提权**。讨论型 crew 中所有 Agent 都应是只读的。

---

## 7. 可观测性

- **实时输出**:每轮打印发言者、backend、发言内容(带颜色区分);
- **过程日志(`--verbose` / 配置 `verbose: true`)**:实时输出各 Agent 的执行过程——claude 侧解析 `stream-json` 事件流打印工具调用(`🔧 工具名: 入参摘要`),codex 侧透传 stderr(session 信息、token 用量);
- **落盘**:每次运行生成 `runs/<时间戳>-<crew名>/transcript.md`,含任务与全部对话;
- **失败可见**:CLI 调用超时/非零退出不中断流程,以 `(调用超时)` / `(调用失败 ...)` 作为该 Agent 本轮发言记入 transcript,便于事后定位。

---

## 8. 成本与限制(已知取舍)

| 事项 | 说明 | 缓解 |
|---|---|---|
| **token 放大** | 每轮全量注入历史,消耗 ≈ 轮数 × Agent 数 × 历史长度 | `max_rounds` 保持 4–8;演进方向见 §4.3 |
| **冷启动延迟** | 每次发言 = 一次 CLI 进程启动(实测 5–20s) | 可接受;对延迟敏感可评估方案 B 的 session 续接 |
| **上下文窗口** | 长讨论 transcript 可能超出模型窗口 | 兜底:`max_rounds`;演进:历史压缩/摘要 |
| **协议依赖模型自觉** | `PASS`/`[END]` 靠 prompt 约束,模型可能不遵守 | 即使完全不遵守也有 `max_rounds` 兜底;实测(§9)两 CLI 均能正确遵守 |
| **backend 能力不对称** | codex 无独立 system-prompt 参数(角色并入 prompt),输出格式与 claude 不同 | 适配层内部消化,对编排器透明 |

---

## 9. 验证情况

冒烟测试(2 Agent:codex + claude,任务"确认 GIL 定义后结束"):

- ✅ 两种 backend 均成功调用并返回干净文本;
- ✅ 后发言者能看到并引用先发言者的内容(transcript 注入生效);
- ✅ `[END]` 协议被正确遵守,讨论一轮内收敛;
- ✅ transcript 正确落盘。

---

## 10. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | conversation + sequential 两模式,claude/codex 双 backend,配置驱动,transcript 落盘 | ✅ 已完成(参考实现已可运行) |
| M2 | 真实场景试用(代码评审/方案讨论 crew),按反馈调协议与参数 | 待做 |
| M3 | 按需演进:manager 调度 / 历史压缩 / 结构化产出(§4.3) | 待评估 |

---

## 11. 待评审的开放问题

1. **角色注入位置**:目前协作协议(§4.1)由编排器强制拼接到每个角色的 system prompt 末尾。是否允许单个 Agent 配置关闭协议(纯自由发言)?
2. **终止语义**:`[END]` 目前是"任一 Agent 宣布即结束"。对重要讨论,是否应改为"全员 `[END]` 才结束"或由指定的 leader 角色专享结束权?
3. **sequential 的循环能力**:是否需要原生支持"审查不通过则打回上一环节"(条件回退),还是留给外部脚本?
4. **输出格式**:transcript 目前只有 Markdown。是否需要 JSONL 机器可读格式供下游程序消费?
