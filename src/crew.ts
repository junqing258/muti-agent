#!/usr/bin/env node
/**
 * muti-agent —— 类 CrewAI 多 Agent 协作框架
 *
 * 复用本机 claude / codex CLI 作为 Agent 执行体:
 *   - 每个 Agent = 一次 CLI headless 调用(claude -p / codex exec)
 *   - 编排器维护共享对话记录,按轮次分发给各 Agent
 *   - 支持两种协作模式:
 *       conversation: 自主多轮对话,由调度 Agent(AI moderator)动态决定
 *                     下一个发言者与终止时机;Agent 可提出完成候选,但无结束权
 *       sequential:   顺序流水线,前一个 Agent 的产出作为后一个的输入
 *
 * 用法:
 *   muti-agent run crews/example.json --task "讨论的问题"
 */
import chalk from "chalk";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROTOCOL = `\
你在参与一个多 Agent 协作讨论,参与者:{participants}。
协作规则:
1. 轮到你时,基于「任务」和「对话记录」发言,要求简洁、直接、有增量,不要重复别人的观点。
2. 可以点名其他 Agent 提问、补充或反驳。
3. 如果本轮你没有新内容要补充,只回复一个单词:PASS
4. 如果你认为任务已完成、讨论已收敛,在正常发言之后,最后一行单独输出:[DONE]。
   [DONE] 只是完成候选,由调度器根据完整记录作最终判定,不会立即结束讨论。
`;

/** 调度器(moderator)的 system prompt:每轮决策下一个发言者或终止。 */
const SCHEDULER_ROLE = `\
你是多 Agent 讨论的调度器(moderator),不参与讨论本身。你是唯一拥有结束讨论权限的角色:根据「任务」「Agent 列表」「对话记录」,决定下一个发言的 Agent,或判定任务已完成。
调度原则:
1. 优先选与当前议题最相关、最可能有增量观点的 Agent(被点名提问/反驳的 Agent 优先)。
2. 不要连续两轮指定同一个 Agent;刚 PASS 的 Agent 除非被点名,否则不要选。
3. Agent 的 [DONE] 仅表示完成候选,不是结束指令。选择 END 前必须确认任务要求已有可用结果,关键异议或待办已关闭,继续发言不会带来有效增量。
4. 只要完成条件不明确、缺少产物或仍有待验证事项,就选择最合适的 Agent 继续处理,不要选择 END。
只输出一行 JSON,不要输出任何其他内容:
{"next":"<Agent 名字,或 END>","reason":"<不超过一句话的中文理由>"}
`;

// ---------- 类型 ----------

type Backend = "claude" | "codex";

interface AgentConfig {
  name: string;
  backend: Backend;
  role: string;
  model?: string;
  skip_permissions?: boolean; // 允许 CLI 免确认使用工具(写文件/执行命令)
  extra_args?: string[];      // 追加给 CLI 的原始参数
  timeout?: number;           // 单次发言超时(秒)
  session_memory?: boolean;   // 为该 Agent 保留 CLI 原生会话(可覆盖 Crew 默认值)
}

interface SchedulerConfig {
  backend?: Backend;
  model?: string;  // 调度所用模型(建议小而快,不填则用 backend 默认值)
  timeout?: number;
  session_memory?: boolean;
}

interface CrewConfig {
  name?: string;
  mode?: string; // conversation | sequential
  max_rounds?: number;
  task?: string;
  verbose?: boolean; // 实时输出各 Agent 的执行过程日志
  session_memory?: boolean; // 默认值;Agent / scheduler 可单独覆盖
  scheduler?: SchedulerConfig;
  agents: AgentConfig[];
}

interface Message {
  round: number;
  sender: string;
  content: string;
}

interface Crew {
  name: string;
  agents: Agent[];
  scheduler: Agent; // conversation 模式的 AI 调度器
  task: string;
  mode: string;
  maxRounds: number;
  verbose: boolean;
}

// ---------- 工具 ----------

const cyan = (s: string) => chalk.bold.cyan(s);
const green = (s: string) => chalk.bold.green(s);
const yellow = (s: string) => chalk.bold.yellow(s);
const gray = (s: string) => chalk.gray(s);
const bold = (s: string) => chalk.bold(s);

/** 执行 CLI 调用,返回 stdout 文本;超时/失败返回占位文本,不抛异常。
 *  onLine 提供时,按行实时回调(stdout/stderr 分开标记)。 */
function runCli(
  cmd: string[],
  input: string | null,
  timeoutSec: number,
  onLine?: (line: string, stream: "stdout" | "stderr") => void
): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const bufs = { stdout: "", stderr: "" };
    const feed = (chunk: string, stream: "stdout" | "stderr") => {
      if (!onLine) return;
      bufs[stream] += chunk;
      let idx: number;
      while ((idx = bufs[stream].indexOf("\n")) >= 0) {
        const line = bufs[stream].slice(0, idx);
        bufs[stream] = bufs[stream].slice(idx + 1);
        if (line.trim()) onLine(line, stream);
      }
    };
    const done = (text: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(text);
      }
    };
    const timer = setTimeout(() => {
      proc.kill();
      done("(调用超时)");
    }, timeoutSec * 1000);
    proc.stdout!.on("data", (d) => {
      const s = String(d);
      out += s;
      feed(s, "stdout");
    });
    proc.stderr!.on("data", (d) => {
      const s = String(d);
      err += s;
      feed(s, "stderr");
    });
    proc.on("error", () => done(`(找不到命令: ${cmd[0]})`));
    proc.on("close", (code) => {
      if (onLine) {
        for (const stream of ["stdout", "stderr"] as const) {
          if (bufs[stream].trim()) onLine(bufs[stream], stream);
        }
      }
      done(code === 0 ? out.trim() : `(调用失败 exit=${code}: ${err.trim().slice(0, 300)})`);
    });
    if (input != null && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

/** 从工具调用入参提取简短描述(命令/文件路径等)。 */
function briefInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path;
  const s = typeof v === "string" ? v : JSON.stringify(input);
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

// ---------- Agent:CLI 执行体封装 ----------

class Agent {
  name: string;
  backend: Backend;
  role: string;
  model?: string;
  skipPermissions: boolean;
  extraArgs: string[];
  timeout: number;
  sessionMemory: boolean;
  sessionId?: string;
  seenMessageCount = 0;

  constructor(cfg: AgentConfig) {
    this.name = cfg.name;
    this.backend = cfg.backend;
    this.role = cfg.role;
    this.model = cfg.model;
    this.skipPermissions = cfg.skip_permissions ?? false;
    this.extraArgs = cfg.extra_args ?? [];
    this.timeout = cfg.timeout ?? 300;
    this.sessionMemory = cfg.session_memory ?? false;
  }

  private buildCmd(verbose: boolean, newSessionId?: string): string[] {
    let cmd: string[];
    if (this.backend === "claude") {
      cmd = verbose
        ? ["claude", "-p", "--output-format", "stream-json", "--verbose",
           "--system-prompt", this.role]
        : ["claude", "-p", "--output-format", "text", "--system-prompt", this.role];
      if (this.model) cmd.push("--model", this.model);
      if (this.skipPermissions) cmd.push("--dangerously-skip-permissions");
      if (this.sessionMemory) {
        if (this.sessionId) cmd.push("--resume", this.sessionId);
        else if (newSessionId) cmd.push("--session-id", newSessionId);
      }
    } else if (this.backend === "codex") {
      cmd = ["codex", "exec"];
      if (this.sessionMemory && this.sessionId) {
        // `codex exec resume` 不接受 --sandbox；恢复时沿用首次建立该 session 的权限策略。
        cmd.push("resume", "--skip-git-repo-check");
        if (this.model) cmd.push("--model", this.model);
        cmd.push(this.sessionId);
      } else {
        cmd.push(
          "--skip-git-repo-check",
          "--sandbox", this.skipPermissions ? "workspace-write" : "read-only",
        );
        if (this.model) cmd.push("--model", this.model);
        // 首次启动时以 JSONL 取得该 Agent 专属 thread_id；续接时已知 ID，无需改变正常文本输出。
        if (this.sessionMemory) cmd.push("--json");
      }
    } else {
      throw new Error(`Agent ${this.name}: 未知 backend '${this.backend}'`);
    }
    return cmd.concat(this.extraArgs);
  }

  /** 发起一次 headless 调用,返回文本输出。verbose 时实时输出执行过程日志。 */
  async say(prompt: string, verbose = false): Promise<string> {
    const newSessionId = this.backend === "claude" && this.sessionMemory && !this.sessionId
      ? randomUUID()
      : undefined;
    const cmd = this.buildCmd(verbose, newSessionId);
    let input: string | null = prompt; // claude -p 从 stdin 读 prompt
    if (this.backend === "codex") {
      // codex 无独立 system-prompt 参数,角色并入 prompt,经参数传入
      cmd.push(`${this.role}\n\n---\n\n${prompt}`);
      input = null;
      // codex 的执行过程日志在 stderr,verbose 时实时透传
      const output = await runCli(cmd, input, this.timeout, verbose
        ? (line, stream) => {
            if (stream === "stderr") console.log(gray(`  │ ${line}`));
          }
        : undefined);
      if (this.sessionMemory && !this.sessionId) {
        const parsed = parseCodexSession(output);
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        return parsed.content ?? output;
      }
      return output;
    }
    if (!verbose) {
      const output = await runCli(cmd, input, this.timeout);
      if (newSessionId && !isCliFailure(output)) this.sessionId = newSessionId;
      return output;
    }
    // claude:stream-json 事件流,提取工具调用过程,最终结果取自 result 事件
    let result: string | null = null;
    const out = await runCli(cmd, input, this.timeout, (line, stream) => {
      if (stream !== "stdout") return;
      let ev: {
        type?: string;
        message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
        result?: unknown;
      };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use") {
            console.log(gray(`  🔧 ${block.name}: ${briefInput(block.input)}`));
          }
        }
      } else if (ev.type === "result" && typeof ev.result === "string") {
        result = ev.result;
      }
    });
    const output = result ?? out;
    if (newSessionId && !isCliFailure(output)) this.sessionId = newSessionId;
    return output;
  }
}

function isCliFailure(output: string): boolean {
  return output.startsWith("(调用超时)") || output.startsWith("(找不到命令:") || output.startsWith("(调用失败 exit=");
}

/** 从首次 `codex exec --json` 的 JSONL 中提取专属 thread_id 和最终 Agent 文本。 */
function parseCodexSession(output: string): { sessionId?: string; content?: string } {
  let sessionId: string | undefined;
  let content: string | undefined;
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        thread_id?: unknown;
        item?: { type?: unknown; text?: unknown };
      };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        content = event.item.text;
      }
    } catch {
      // 非 JSONL 行属于 CLI 警告或错误,不影响正常结果提取。
    }
  }
  return { sessionId, content };
}

// ---------- Crew:配置与编排 ----------

function loadCrew(configPath: string, task?: string, maxRounds?: number, verbose?: boolean): Crew {
  const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as CrewConfig;
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) {
    throw new Error("错误: Crew 至少需要一个 Agent");
  }
  const agents = cfg.agents.map((a) => new Agent({
    ...a,
    session_memory: a.session_memory ?? cfg.session_memory ?? false,
  }));
  const mode = cfg.mode ?? "conversation";
  if (mode !== "conversation" && mode !== "sequential") {
    throw new Error(`错误: 未知 mode '${mode}'，仅支持 conversation 或 sequential`);
  }
  if (mode === "conversation") {
    const names = agents.map((a) => a.name).join("、");
    for (const a of agents) {
      a.role += "\n\n" + PROTOCOL.replace("{participants}", names);
    }
  }
  const finalTask = task ?? cfg.task ?? "";
  if (!finalTask) {
    console.error("错误: 未提供任务(config.task 或 --task)");
    process.exit(1);
  }
  return {
    name: cfg.name ?? configPath.replace(/.*\//, "").replace(/\.json$/, ""),
    agents,
    scheduler: new Agent({
      name: "scheduler",
      backend: cfg.scheduler?.backend ?? agents[0].backend,
      role: SCHEDULER_ROLE,
      model: cfg.scheduler?.model, // 不指定则用 CLI 默认模型
      timeout: cfg.scheduler?.timeout ?? 120,
      session_memory: cfg.scheduler?.session_memory ?? cfg.session_memory ?? false,
    }),
    task: finalTask,
    mode,
    maxRounds: maxRounds ?? cfg.max_rounds ?? 6,
    verbose: verbose ?? cfg.verbose ?? true,
  };
}

function renderTranscript(messages: Message[]): string {
  if (messages.length === 0) return "(暂无)";
  return messages
    .map((m) => `[第${m.round}轮] ${m.sender}:\n${m.content}`)
    .join("\n\n");
}

/** 调度器输入:任务 + Agent 列表 + 对话记录。 */
function schedulerPrompt(crew: Crew, messages: Message[]): string {
  return (
    `任务:${crew.task}\n\n` +
    `Agent 列表:\n${crew.agents.map((a) => `- ${a.name}: ${a.role.split("\n\n")[0]}`).join("\n")}\n\n` +
    `对话记录:\n${renderTranscript(messages)}\n\n` +
    `---\n请输出 JSON,决定下一个发言者或 END。`
  );
}

/** 有原生会话的 Agent 只接收自上次发言以来的增量；无会话时维持全量 transcript 注入。 */
function contextFor(agent: Agent, messages: Message[]): Message[] {
  return agent.sessionMemory && agent.sessionId
    ? messages.slice(agent.seenMessageCount)
    : messages;
}

function contextLabel(agent: Agent): string {
  return agent.sessionMemory && agent.sessionId
    ? "自上次你发言后的对话记录"
    : "对话记录";
}

/** 成功建立原生会话后，记录该 Agent 已经从其 CLI 会话中看到的 transcript 位置。 */
function markContextSeen(agent: Agent, messages: Message[]): void {
  if (agent.sessionMemory && agent.sessionId) agent.seenMessageCount = messages.length;
}

/** 解析调度器输出;非法时返回 null(调用方回退 round-robin)。 */
function parseSchedule(reply: string): { next: string; reason: string } | null {
  const m = reply.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { next?: unknown; reason?: unknown };
    if (typeof o.next === "string" && o.next.trim()) {
      return { next: o.next.trim(), reason: typeof o.reason === "string" ? o.reason : "" };
    }
  } catch {
    // 忽略,走回退
  }
  return null;
}

/** 自主多轮对话:每轮由调度 Agent 决定下一个发言者或最终结束;
 *  调度失败回退 round-robin。连续全员 PASS 与次数上限仅为防死循环的系统兜底。 */
async function runConversation(crew: Crew): Promise<Message[]> {
  const messages: Message[] = [];
  const maxTurns = crew.maxRounds * crew.agents.length; // 语义:每"轮"≈ 每个 Agent 平均发言一次
  let fallbackIdx = 0; // 回退指针:按配置顺序轮转
  let consecutivePasses = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // --- 调度:决定下一个发言者 ---
    let speaker = crew.agents[fallbackIdx % crew.agents.length];
    console.log(gray(`调度中(scheduler/${crew.scheduler.model ?? "claude"})...`));
    const reply = await crew.scheduler.say(schedulerPrompt(crew, contextFor(crew.scheduler, messages)));
    markContextSeen(crew.scheduler, messages);
    const decision = parseSchedule(reply);
    if (decision?.next === "END") {
      console.log(green(`讨论结束(调度判定:${decision.reason})`));
      return messages;
    }
    const picked = decision ? crew.agents.find((a) => a.name === decision.next) : undefined;
    if (picked && decision) {
      speaker = picked;
      fallbackIdx = crew.agents.indexOf(picked) + 1;
      console.log(gray(`调度 → ${speaker.name}(${decision.reason})`));
    } else {
      if (decision) console.log(yellow(`调度指定了未知 Agent「${decision.next}」,回退顺序轮转`));
      else console.log(yellow("调度输出无法解析,回退顺序轮转"));
      fallbackIdx++;
    }

    // --- 发言 ---
    const prompt =
      `任务:${crew.task}\n\n` +
      `${contextLabel(speaker)}:\n${renderTranscript(contextFor(speaker, messages))}\n\n` +
      `---\n轮到你了,${speaker.name}。请发言(或回复 PASS / 以 [DONE] 提出完成候选)。`;
    console.log(`\n${cyan(`[第${turn}次] ${speaker.name} (${speaker.backend}) 发言中...`)}`);
    const say = await speaker.say(prompt, crew.verbose);
    const isPass = say.trim().replace(/[.。]$/, "") === "PASS";
    if (isPass) {
      consecutivePasses++;
      messages.push({ round: turn, sender: speaker.name, content: "PASS" });
      console.log(gray(`${speaker.name}: PASS`));
    } else {
      consecutivePasses = 0;
      messages.push({ round: turn, sender: speaker.name, content: say });
      console.log(say + "\n");
    }
    markContextSeen(speaker, messages);
    if (consecutivePasses >= crew.agents.length) {
      console.log(green("讨论结束(全员连续 PASS；系统兜底)"));
      return messages;
    }
  }
  console.log(yellow(`达到最大发言次数 ${maxTurns}(max_rounds=${crew.maxRounds} × ${crew.agents.length}),强制结束`));
  return messages;
}

/** 顺序流水线:每个 Agent 依次处理,可见此前所有产出。 */
async function runSequential(crew: Crew): Promise<Message[]> {
  const messages: Message[] = [];
  for (let i = 0; i < crew.agents.length; i++) {
    const agent = crew.agents[i];
    const prompt =
      `任务:${crew.task}\n\n` +
      `此前各环节产出:\n${renderTranscript(messages)}\n\n` +
      `---\n你是第 ${i + 1} 环(${agent.name}),请完成你的职责并输出结果。`;
    console.log(`\n${cyan(`[环节${i + 1}] ${agent.name} (${agent.backend}) 处理中...`)}`);
    const reply = await agent.say(prompt);
    messages.push({ round: i + 1, sender: agent.name, content: reply });
    console.log(reply + "\n");
  }
  return messages;
}

// ---------- 入口 ----------

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const USAGE = `muti-agent —— 类 CrewAI 多 Agent 协作框架(复用 claude / codex CLI)

用法:
  muti-agent run <config.json> [选项]

选项:
  --task <文本>      覆盖配置中的任务
  --max-rounds <N>   覆盖最大轮数
  -o, --out <目录>   transcript 输出目录(默认 runs/<时间戳>-<crew名>/)
  --verbose          实时输出各 Agent 的执行过程日志(默认开启;配置 "verbose": false 可关闭)
  -h, --help         显示帮助
  -v, --version      显示版本
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  return pkg.version;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: "string" },
      "max-rounds": { type: "string" },
      out: { type: "string", short: "o" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [cmd, configPath] = positionals;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }
  if (cmd !== "run" || !configPath) {
    console.error(USAGE);
    process.exit(1);
  }

  const crew = loadCrew(
    configPath,
    values.task,
    values["max-rounds"] ? Number(values["max-rounds"]) : undefined,
    values.verbose || undefined
  );
  console.log(
    bold(
      `Crew: ${crew.name} | 模式: ${crew.mode} | ` +
        `Agent: ${crew.agents.map((a) => `${a.name}(${a.backend})`).join("、")}`
    )
  );
  console.log(`任务: ${crew.task}`);

  const t0 = Date.now();
  const messages =
    crew.mode === "conversation" ? await runConversation(crew) : await runSequential(crew);

  const outDir = values.out ?? join("runs", `${timestamp()}-${crew.name}`);
  mkdirSync(outDir, { recursive: true });
  const md = [
    `# ${crew.name}`,
    "",
    `任务: ${crew.task}`,
    "",
    ...messages.map((m) => `## [第${m.round}轮] ${m.sender}\n\n${m.content}\n`),
  ];
  writeFileSync(join(outDir, "transcript.md"), md.join("\n"), "utf-8");
  console.log(gray(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s,transcript 已保存: ${outDir}/transcript.md`));
}

await main();
