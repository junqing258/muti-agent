#!/usr/bin/env node
/**
 * muti-agent —— 类 CrewAI 多 Agent 协作框架
 *
 * 复用本机 claude / codex CLI 作为 Agent 执行体:
 *   - 每个 Agent = 一次 CLI headless 调用(claude -p / codex exec)
 *   - 编排器维护共享对话记录,按轮次分发给各 Agent
 *   - 支持两种协作模式:
 *       conversation: 自主多轮对话,Agent 互相应答,PASS 跳过 / [END] 结束
 *       sequential:   顺序流水线,前一个 Agent 的产出作为后一个的输入
 *
 * 用法:
 *   muti-agent run crews/example.json --task "讨论的问题"
 */
import chalk from "chalk";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROTOCOL = `\
你在参与一个多 Agent 协作讨论,参与者:{participants}。
协作规则:
1. 轮到你时,基于「任务」和「对话记录」发言,要求简洁、直接、有增量,不要重复别人的观点。
2. 可以点名其他 Agent 提问、补充或反驳。
3. 如果本轮你没有新内容要补充,只回复一个单词:PASS
4. 如果你认为任务已完成、讨论已收敛,在正常发言之后,最后一行单独输出:[END]
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
}

interface CrewConfig {
  name?: string;
  mode?: string; // conversation | sequential
  max_rounds?: number;
  task?: string;
  verbose?: boolean; // 实时输出各 Agent 的执行过程日志
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

  constructor(cfg: AgentConfig) {
    this.name = cfg.name;
    this.backend = cfg.backend;
    this.role = cfg.role;
    this.model = cfg.model;
    this.skipPermissions = cfg.skip_permissions ?? false;
    this.extraArgs = cfg.extra_args ?? [];
    this.timeout = cfg.timeout ?? 300;
  }

  private buildCmd(verbose: boolean): string[] {
    let cmd: string[];
    if (this.backend === "claude") {
      cmd = verbose
        ? ["claude", "-p", "--output-format", "stream-json", "--verbose",
           "--system-prompt", this.role]
        : ["claude", "-p", "--output-format", "text", "--system-prompt", this.role];
      if (this.model) cmd.push("--model", this.model);
      if (this.skipPermissions) cmd.push("--dangerously-skip-permissions");
    } else if (this.backend === "codex") {
      cmd = [
        "codex", "exec", "--skip-git-repo-check",
        "--sandbox", this.skipPermissions ? "workspace-write" : "read-only",
      ];
      if (this.model) cmd.push("--model", this.model);
    } else {
      throw new Error(`Agent ${this.name}: 未知 backend '${this.backend}'`);
    }
    return cmd.concat(this.extraArgs);
  }

  /** 发起一次 headless 调用,返回文本输出。verbose 时实时输出执行过程日志。 */
  async say(prompt: string, verbose = false): Promise<string> {
    const cmd = this.buildCmd(verbose);
    let input: string | null = prompt; // claude -p 从 stdin 读 prompt
    if (this.backend === "codex") {
      // codex 无独立 system-prompt 参数,角色并入 prompt,经参数传入
      cmd.push(`${this.role}\n\n---\n\n${prompt}`);
      input = null;
      // codex 的执行过程日志在 stderr,verbose 时实时透传
      return runCli(cmd, input, this.timeout, verbose
        ? (line, stream) => {
            if (stream === "stderr") console.log(gray(`  │ ${line}`));
          }
        : undefined);
    }
    if (!verbose) return runCli(cmd, input, this.timeout);
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
    return result ?? out;
  }
}

// ---------- Crew:配置与编排 ----------

function loadCrew(configPath: string, task?: string, maxRounds?: number, verbose?: boolean): Crew {
  const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as CrewConfig;
  const agents = cfg.agents.map((a) => new Agent(a));
  const mode = cfg.mode ?? "conversation";
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
    task: finalTask,
    mode,
    maxRounds: maxRounds ?? cfg.max_rounds ?? 6,
    verbose: verbose ?? cfg.verbose ?? false,
  };
}

function renderTranscript(messages: Message[]): string {
  if (messages.length === 0) return "(暂无)";
  return messages
    .map((m) => `[第${m.round}轮] ${m.sender}:\n${m.content}`)
    .join("\n\n");
}

/** 自主多轮对话:round-robin 发言,全员 PASS 或任一 [END] 结束。 */
async function runConversation(crew: Crew): Promise<Message[]> {
  const messages: Message[] = [];
  for (let r = 1; r <= crew.maxRounds; r++) {
    let passes = 0;
    for (const agent of crew.agents) {
      const prompt =
        `任务:${crew.task}\n\n` +
        `对话记录:\n${renderTranscript(messages)}\n\n` +
        `---\n轮到你了,${agent.name}。请发言(或回复 PASS / 以 [END] 结束)。`;
      console.log(`\n${cyan(`[第${r}轮] ${agent.name} (${agent.backend}) 发言中...`)}`);
      const reply = await agent.say(prompt, crew.verbose);
      const isEnd = reply.includes("[END]");
      const isPass = reply.trim().replace(/[.。]$/, "") === "PASS";
      if (isPass) {
        passes++;
        console.log(gray(`${agent.name}: PASS`));
      } else {
        messages.push({ round: r, sender: agent.name, content: reply });
        console.log(reply + "\n");
      }
      if (isEnd) {
        console.log(green("讨论结束([END])"));
        return messages;
      }
    }
    if (passes === crew.agents.length) {
      console.log(green("讨论结束(全员 PASS)"));
      return messages;
    }
  }
  console.log(yellow(`达到最大轮数 ${crew.maxRounds},强制结束`));
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
  --verbose          实时输出各 Agent 的执行过程日志(工具调用等)
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
