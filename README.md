# muti-agent

类 CrewAI 的多 Agent 协作框架。**不重造 Agent**——直接复用本机的 `claude`(Claude Code)和 `codex`(Codex CLI)作为 Agent 执行体,框架只负责编排:角色注入、对话记录维护、轮次调度、终止判定。

## 原理

```
┌─────────────────────── 编排器 src/crew.ts ─────────────────────┐
│  共享对话记录(transcript)                                     │
│    │ 第 N 轮 prompt = 任务 + 全部历史 + "轮到你了"             │
│    ▼                                                         │
│  Agent A ──► claude -p --system-prompt "<角色>"   (子进程)    │
│  Agent B ──► codex exec --sandbox read-only       (子进程)    │
│    │                                                         │
│  调度 Agent(默认复用首个 Agent 的 backend)── 决定下一个发言者 / END │
│    │                                                         │
│    ▼ 终止条件:调度判定 END / 全员 PASS / 次数上限            │
└──────────────────────────────────────────────────────────────┘
```

每次发言是一次独立的 headless CLI 调用(无对话记忆),记忆由编排器以 transcript 形式注入 prompt——这与 CrewAI 的"共享上下文"模型一致。

## 依赖

- Node.js ≥ 23.6(原生运行 TypeScript,无需编译;开发依赖仅 typescript + @types/node,用于类型检查)
- 已登录的 `claude` CLI 和/或 `codex` CLI

## 安装

```bash
npm install    # 安装类型检查依赖
npm link       # 全局安装 muti-agent 命令(卸载:npm unlink -g)
```

## 使用

```bash
muti-agent --help

# 用配置里的任务运行示例 crew(3 个 Agent 自主讨论)
muti-agent run crews/example.json

# 覆盖任务与轮数
muti-agent run crews/example.json --task "要不要引入微服务?" --max-rounds 4

# 类型检查
npm run typecheck
```

运行结束后 transcript 保存在 `runs/<时间戳>-<crew名>/transcript.md`。

## Crew 配置(JSON)

```jsonc
{
  "name": "design-review",
  "mode": "conversation",     // conversation(自主多轮对话)| sequential(顺序流水线)
  "max_rounds": 6,
  "task": "讨论的问题",         // 可被 --task 覆盖
  "session_memory": false,     // 可选;为每个 Agent 保留其 CLI 原生会话
  "scheduler": {               // 可选,conversation 模式的 AI 调度器
    "backend": "claude",      // 可选;不填则复用第一个 Agent 的 backend
    "model": null,             // 调度决策所用模型;不填用 backend 默认模型
    "timeout": 120,            // 单次调度超时(秒)
    "session_memory": true     // 可选;覆盖 Crew 的 session_memory
  },
  "agents": [
    {
      "name": "architect",
      "backend": "claude",    // claude | codex
      "role": "角色设定,作为 system prompt 注入",
      "model": null,          // 可选,覆盖 CLI 默认模型
      "skip_permissions": false, // true = Agent 可免确认写文件/跑命令(慎用)
      "extra_args": [],       // 追加给 CLI 的原始参数
      "timeout": 300,         // 单次发言超时(秒)
      "session_memory": true  // 可选;覆盖 Crew 的 session_memory
    }
  ]
}
```

## 两种协作模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `conversation` | 每次发言前由调度 Agent 全局决策:点名下一个最相关发言者，且仅调度器可在核验任务完成后输出 END。Agent 的 `[DONE]` 仅为完成候选；调度失败自动回退顺序轮转。 | 方案讨论、评审、辩论 |
| `sequential` | 按配置顺序各执行一次,可见此前所有环节的产出 | 调研→编码→审查流水线 |

## 说明与取舍

- **过程日志(--verbose,默认开启)**:claude 走 `stream-json` 事件流,解析出 `🔧 工具名: 入参摘要` 实时打印;codex 直接透传 stderr(session 信息、token 用量等,注意它会回显完整 prompt,较吵)。可在配置顶层设 `"verbose": false` 关闭。
- **对话历史的成本**:每轮都把完整 transcript 发给每个 Agent,轮数 × Agent 数 × 历史长度会快速放大 token 消耗。`max_rounds` 保持小值(4–8)。
- **原生会话记忆(可选)**:设定顶层 `"session_memory": true` 后，每个 Agent 与 Scheduler 都会维持各自独立的 CLI session；后续 prompt 只注入该角色尚未看到的 transcript 增量，保留工具上下文并减少重复 token。可在 Agent 或 `scheduler` 上单独覆盖。该模式会由 CLI 在本机保存会话记录，敏感任务请保持默认 `false`；Codex 恢复时沿用首次创建会话的权限策略。session ID 仅存在于当前 `muti-agent run` 进程，下一次运行会创建新会话。
- **默认只读**:`skip_permissions: false` 时 claude 的工具需确认(headless 下即不可用)、codex 为 `read-only` 沙箱——Agent 只能"说"不能"做"。需要 Agent 真正改代码时再对单个 Agent 打开。
- **结束权与防死循环**:任务是否完成只由调度器判定；Agent 的 `[DONE]` 只提示调度器核验。全员连续 PASS 与 `max_rounds × Agent 数` 是调度异常或无进展时的系统兜底，不代表业务验收。调度输出非法(非 JSON / 点了不存在的名字)时回退顺序轮转,不会卡死。
- **AI 调度的成本**:conversation 模式每次发言前多一次调度调用(小模型,秒级);要极致省 token 可改用 `sequential`,或把 `scheduler.model` 换成更便宜的模型。
- **扩展 backend**:在 `Agent.buildCmd()` / `say()` 中加一个分支即可接入其他 CLI(如 gemini)。
