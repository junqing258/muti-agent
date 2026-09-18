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
│    ▼ 终止条件:全员 PASS / 任一 Agent 输出 [END] / max_rounds   │
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
  "agents": [
    {
      "name": "architect",
      "backend": "claude",    // claude | codex
      "role": "角色设定,作为 system prompt 注入",
      "model": null,          // 可选,覆盖 CLI 默认模型
      "skip_permissions": false, // true = Agent 可免确认写文件/跑命令(慎用)
      "extra_args": [],       // 追加给 CLI 的原始参数
      "timeout": 300          // 单次发言超时(秒)
    }
  ]
}
```

## 两种协作模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `conversation` | round-robin 发言,可见全部历史;`PASS` 跳过,`[END]` 结束,全员 PASS 或达最大轮数终止 | 方案讨论、评审、辩论 |
| `sequential` | 按配置顺序各执行一次,可见此前所有环节的产出 | 调研→编码→审查流水线 |

## 说明与取舍

- **对话历史的成本**:每轮都把完整 transcript 发给每个 Agent,轮数 × Agent 数 × 历史长度会快速放大 token 消耗。`max_rounds` 保持小值(4–8)。
- **默认只读**:`skip_permissions: false` 时 claude 的工具需确认(headless 下即不可用)、codex 为 `read-only` 沙箱——Agent 只能"说"不能"做"。需要 Agent 真正改代码时再对单个 Agent 打开。
- **防死循环**:三重终止(`[END]` / 全员 PASS / `max_rounds`),不会出现无限对话。
- **扩展 backend**:在 `Agent.buildCmd()` / `say()` 中加一个分支即可接入其他 CLI(如 gemini)。
