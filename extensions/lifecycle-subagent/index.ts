import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-6";
const RUNS_DIR = path.join("data", "subagent-runs");

type RunStatus = "running" | "completed" | "incomplete" | "failed" | "canceled";
type RunMode = "single";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "incomplete", "failed", "canceled"]);

// planner/developer/tester are expected to log their stage via the
// record_cycle tool (see extensions/cycle-records.ts) when they actually do
// lifecycle work. A clean exit with no such call doesn't necessarily mean
// something went wrong — some tasks legitimately don't touch the DB — but it
// means the lead shouldn't treat the run as a verified completion without
// checking. Status is a computed fact about what happened, not something the
// model self-reports.
const LIFECYCLE_STAGE_BY_ROLE: Record<string, string> = {
	planner: "approach",
	developer: "implementation",
	tester: "feedback",
};

// Deliberately narrow (denylist, not allowlist): a full deny-by-default env
// scope risks silently breaking pi's/claude's own auth or config resolution
// without live-testing every provider path this harness uses. Add prefixes
// here for any third-party service credentials that end up in your own
// mcp.json/env but have no business reaching a coding subagent (an accounting
// API, an internal ticketing system, etc.) — this list ships empty since
// there's nothing generic to deny by default. A real allowlist is future
// work once each runner's actual required env-var set is enumerated and
// tested.
const ENV_DENYLIST_PREFIXES: string[] = [];

function scopedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (ENV_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			delete env[key];
		}
	}
	return env;
}
const COLLECTOR_RUN_ID_PATTERN = /\brun_[a-z0-9]+\b/gi;
const COLLECTOR_AGENT_NAME = "collector";
const RUN_STATUS_POLL_MS = 1000;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  runner?: "pi" | "claude-cli";
  stopReason?: string;
  errorMessage?: string;
}

interface RunRecord {
  runId: string;
  status: RunStatus;
  statusReason?: string;
  mode: RunMode;
  background: boolean;
  autoHandoff: boolean;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  sessionId?: string;
  sessionProfileSource?: string;
  sessionProfilePath?: string;
  previousRunId?: string;
  pid?: number;
  results: SingleResult[];
  artifactPath: string;
}

interface SubagentDetails {
  action: string;
  runId?: string;
  mode?: RunMode;
  agentScope?: AgentScope;
  projectAgentsDir?: string | null;
  sessionId?: string;
  sessionProfileSource?: string;
  sessionProfilePath?: string;
  previousRunId?: string;
  status?: RunStatus;
  artifactPath?: string;
  results?: SingleResult[];
  runs?: Array<Pick<RunRecord, "runId" | "status" | "createdAt" | "updatedAt">>;
}

const activeRuns = new Map<string, { child: ChildProcess; artifactPath: string }>();

const ActionSchema = StringEnum(["catalog", "run", "status", "result", "cancel", "cleanup"] as const, {
  description: "subagent action",
});

const SubagentParams = Type.Object({
  action: ActionSchema,
  agent: Type.Optional(Type.String({ description: "Agent name for action=run" })),
  task: Type.Optional(Type.String({ description: "Task text for action=run" })),
  runId: Type.Optional(Type.String({ description: "Run id for status/result/cancel/cleanup" })),
  previousRunId: Type.Optional(Type.String({
    description: "For action=run: runId of a prior terminal run whose final output is automatically prepended as context for this run, instead of relying on the lead to relay it manually.",
  })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "both" })),
  background: Type.Optional(Type.Boolean({ default: true })),
  autoHandoff: Type.Optional(Type.Boolean({ default: true })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getRunsDir(cwd: string): string {
  return path.join(cwd, RUNS_DIR);
}

function ensureRunsDir(cwd: string): string {
  const dir = getRunsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getArtifactPath(cwd: string, runId: string): string {
  return path.join(ensureRunsDir(cwd), `${runId}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return `run_${Math.random().toString(16).slice(2, 10)}`;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function isTerminalRunStatus(status?: RunStatus | null): status is Exclude<RunStatus, "running"> {
  return status ? TERMINAL_RUN_STATUSES.has(status) : false;
}

// The computed status (and why, when it's not a clean completion) must be
// impossible to miss in the text a caller actually reads — burying it only
// in `details` while `content` shows the subagent's own prose let a false
// "recorded successfully" narration go unnoticed in practice. Always lead
// with the real, code-derived status; never let the model's own account be
// the only thing visible.
function formatStatusLine(status: RunStatus, reason?: string): string {
  return `[status: ${status}]${reason ? ` ${reason}` : ""}`;
}

function hasSuccessfulCycleRecord(messages: Message[]): boolean {
  return messages.some((msg: any) => msg?.role === "toolResult" && msg?.toolName === "record_cycle" && !msg?.isError);
}

function deriveCompletionStatus(agentName: string, gated: boolean, messages: Message[]): { status: RunStatus; reason?: string } {
  if (!gated) return { status: "failed" };
  const stage = LIFECYCLE_STAGE_BY_ROLE[agentName];
  if (stage && !hasSuccessfulCycleRecord(messages)) {
    return {
      status: "incomplete",
      reason: `Exited clean but no successful record_cycle call (stage: ${stage}) was observed — the ${stage} DB record for this run may be missing. Not necessarily an error: some tasks legitimately don't produce one, but check before treating this run as a verified completion.`,
    };
  }
  return { status: "completed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCollectorMonitoredRunIds(agentName: string, task: string, currentRunId: string): string[] {
  if (agentName !== COLLECTOR_AGENT_NAME) return [];
  const matches = task.match(COLLECTOR_RUN_ID_PATTERN) || [];
  return [...new Set(matches.filter((runId) => runId !== currentRunId))];
}

async function waitForRunTerminal(cwd: string, runId: string): Promise<RunRecord | null> {
  while (true) {
    const record = loadRun(cwd, runId);
    if (!record) return null;
    if (isTerminalRunStatus(record.status)) return record;
    await sleep(RUN_STATUS_POLL_MS);
  }
}

// Returns true if all monitored runs reached terminal state, false if any artifact was missing.
async function waitForCollectorDependencyIfNeeded(record: RunRecord, result: SingleResult): Promise<boolean> {
  const monitoredRunIds = getCollectorMonitoredRunIds(result.agent, result.task, record.runId);
  if (monitoredRunIds.length === 0) return true;
  for (const runId of monitoredRunIds) {
    const dep = await waitForRunTerminal(record.cwd, runId);
    if (!dep) return false;
  }
  return true;
}

function saveRun(record: RunRecord): void {
  record.updatedAt = nowIso();
  fs.writeFileSync(record.artifactPath, JSON.stringify(record, null, 2));
}

function loadRun(cwd: string, runId: string): RunRecord | null {
  const artifactPath = getArtifactPath(cwd, runId);
  if (!fs.existsSync(artifactPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

function listRuns(cwd: string): RunRecord[] {
  const dir = ensureRunsDir(cwd);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const records: RunRecord[] = [];
  for (const file of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RunRecord;
      records.push(record);
    } catch {
      // ignore unreadable files
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safe = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safe}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

function buildInitialRecord(
  cwd: string,
  runId: string,
  background: boolean,
  autoHandoff: boolean,
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  sessionId?: string,
  sessionProfileSource?: string,
  sessionProfilePath?: string,
  previousRunId?: string,
): RunRecord {
  const artifactPath = getArtifactPath(cwd, runId);
  return {
    runId,
    status: "running",
    mode: "single",
    background,
    autoHandoff,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cwd,
    agentScope,
    projectAgentsDir,
    sessionId,
    sessionProfileSource,
    sessionProfilePath,
    previousRunId,
    results: [],
    artifactPath,
  };
}

function makeResult(agent: AgentConfig, task: string): SingleResult {
  return {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: agent.model,
    runner: agent.runner,
  };
}

async function spawnPiAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  result: SingleResult,
  record: RunRecord,
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
): Promise<ChildProcess> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tempDir: string | null = null;
  let tempPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    tempDir = tmp.dir;
    tempPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tempPromptPath);
  }
  args.push(`Task: ${task}`);

  const invocation = getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: scopedEnv(),
  });

  record.pid = child.pid;
  saveRun(record);

  let buffer = "";
  const flushUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
      details: {
        action: "run",
        runId: record.runId,
        status: record.status,
        artifactPath: record.artifactPath,
        results: record.results,
      },
    });
  };

  const cleanupTemp = () => {
    if (tempPromptPath) {
      try {
        fs.unlinkSync(tempPromptPath);
      } catch {}
    }
    if (tempDir) {
      try {
        fs.rmdirSync(tempDir);
      } catch {}
    }
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message as Message;
      result.messages.push(msg);
      if (msg.role === "assistant") {
        result.usage.turns += 1;
        const usage = (msg as any).usage;
        if (usage) {
          result.usage.input += usage.input || 0;
          result.usage.output += usage.output || 0;
          result.usage.cacheRead += usage.cacheRead || 0;
          result.usage.cacheWrite += usage.cacheWrite || 0;
          result.usage.cost += usage.cost?.total || 0;
          result.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!result.model && (msg as any).model) result.model = (msg as any).model;
        if ((msg as any).stopReason) result.stopReason = (msg as any).stopReason;
        if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
      }
      saveRun(record);
      flushUpdate();
    }

    if (event.type === "tool_result_end" && event.message) {
      result.messages.push(event.message as Message);
      saveRun(record);
      flushUpdate();
    }
  };

  child.stdout?.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  child.stderr?.on("data", (data) => {
    result.stderr += data.toString();
    saveRun(record);
  });

  child.on("close", (code) => {
    void (async () => {
      try {
        if (buffer.trim()) processLine(buffer);
        result.exitCode = code ?? 0;
        if (record.status !== "canceled") {
          if (result.exitCode === 0) {
            const gated = await waitForCollectorDependencyIfNeeded(record, result);
            const derived = deriveCompletionStatus(result.agent, gated, result.messages);
            record.status = derived.status;
            record.statusReason = derived.reason;
          } else {
            record.status = "failed";
          }
        }
        saveRun(record);
      } finally {
        cleanupTemp();
      }
    })();
  });

  child.on("error", (error) => {
    result.exitCode = 1;
    result.stderr += `\n${String(error)}`;
    if (record.status !== "canceled") {
      record.status = "failed";
    }
    saveRun(record);
    cleanupTemp();
  });

  return child;
}

async function spawnClaudeAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  result: SingleResult,
  record: RunRecord,
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
): Promise<ChildProcess> {
  const model = agent.model || CLAUDE_DEFAULT_MODEL;
  result.model = model;

  const child = spawn(
    "claude",
    ["-p", "--model", model, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: scopedEnv() },
  );

  record.pid = child.pid;
  saveRun(record);

  let rawStdout = "";
  let finalResultText: string | undefined;
  let sawError = false;
  // tool_use events only carry the tool name; the matching tool_result event
  // only carries tool_use_id, so track name-by-id to label results correctly.
  const toolNameById = new Map<string, string>();

  const flushUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
      details: {
        action: "run",
        runId: record.runId,
        status: record.status,
        artifactPath: record.artifactPath,
        results: record.results,
      },
    });
  };

  // Normalizes one --output-format stream-json line (Anthropic's native
  // message shape) into the same Message shape spawnPiAgent already produces,
  // so every downstream consumer (getFinalOutput, subagent-status.ts's live
  // feed, etc.) works identically regardless of which runner executed.
  const processClaudeLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "assistant" && event.message) {
      const parts: Message["content"] = [];
      for (const part of event.message.content ?? []) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "tool_use") {
          toolNameById.set(part.id, part.name);
          parts.push({ type: "toolCall", id: part.id, name: part.name, arguments: part.input ?? {} });
        } else if (part.type === "thinking") {
          parts.push({ type: "thinking", thinking: part.thinking ?? "" });
        }
      }
      if (parts.length === 0) return;
      const usage = event.message.usage;
      result.messages.push({
        role: "assistant",
        content: parts,
        model: event.message.model ?? model,
        timestamp: Date.now(),
        ...(usage
          ? {
              usage: {
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheWrite: usage.cache_creation_input_tokens ?? 0,
                totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }
          : {}),
      } as Message);
      result.usage.turns += 1;
      if (usage) {
        result.usage.input += usage.input_tokens ?? 0;
        result.usage.output += usage.output_tokens ?? 0;
        result.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
        result.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      }
      saveRun(record);
      flushUpdate();
      return;
    }

    if (event.type === "user" && event.message && Array.isArray(event.message.content)) {
      for (const part of event.message.content) {
        if (part.type !== "tool_result") continue;
        const content = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
        result.messages.push({
          role: "toolResult",
          toolCallId: part.tool_use_id,
          toolName: toolNameById.get(part.tool_use_id) ?? "tool",
          content: [{ type: "text", text: content }],
          isError: !!part.is_error,
          timestamp: Date.now(),
        } as Message);
      }
      saveRun(record);
      flushUpdate();
      return;
    }

    if (event.type === "result") {
      finalResultText = typeof event.result === "string" ? event.result : undefined;
      sawError = !!event.is_error;
      if (typeof event.total_cost_usd === "number") result.usage.cost = event.total_cost_usd;
    }
  };

  let buffer = "";
  child.stdout?.on("data", (data) => {
    const text = data.toString();
    rawStdout += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processClaudeLine(line);
  });

  child.stderr?.on("data", (data) => {
    result.stderr += data.toString();
    saveRun(record);
  });

  child.on("close", (code) => {
    void (async () => {
      if (buffer.trim()) processClaudeLine(buffer);
      result.exitCode = code ?? 0;

      // Parsing failed entirely (unexpected output shape, older claude CLI,
      // etc.) — fall back to the raw text blob rather than losing the run.
      if (result.messages.length === 0) {
        const text = rawStdout.trim();
        result.messages = [
          { role: "assistant", content: [{ type: "text", text: text || "(no output)" }], model, timestamp: Date.now() } as Message,
        ];
      } else if (finalResultText && getFinalOutput(result.messages) !== finalResultText) {
        // The stream's own final "result" line is authoritative for the
        // answer text even if the last assistant turn was a tool call.
        result.messages.push({
          role: "assistant",
          content: [{ type: "text", text: finalResultText }],
          model,
          timestamp: Date.now(),
        } as Message);
      }

      result.stopReason = result.exitCode === 0 && !sawError ? "endTurn" : "error";
      if (record.status !== "canceled") {
        if (result.exitCode === 0 && !sawError) {
          const gated = await waitForCollectorDependencyIfNeeded(record, result);
          const derived = deriveCompletionStatus(result.agent, gated, result.messages);
          record.status = derived.status;
          record.statusReason = derived.reason;
        } else {
          record.status = "failed";
        }
      }
      saveRun(record);
      flushUpdate();
    })();
  });

  child.on("error", (error) => {
    result.exitCode = 1;
    result.stderr += `\n${String(error)}`;
    if (record.status !== "canceled") {
      record.status = "failed";
    }
    saveRun(record);
  });

  const prompt = agent.systemPrompt?.trim()
    ? `${agent.systemPrompt.trim()}\n\nTask: ${task}`
    : `Task: ${task}`;
  child.stdin?.write(prompt);
  child.stdin?.end();

  return child;
}

async function startRun(
  pi: ExtensionAPI,
  cwd: string,
  agent: AgentConfig,
  task: string,
  record: RunRecord,
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
): Promise<void> {
  const result = makeResult(agent, task);
  record.results = [result];
  saveRun(record);

  const child = agent.runner === "claude-cli"
    ? await spawnClaudeAgent(cwd, agent, task, result, record, onUpdate)
    : await spawnPiAgent(cwd, agent, task, result, record, onUpdate);

  activeRuns.set(record.runId, { child, artifactPath: record.artifactPath });

  child.on("close", () => {
    void (async () => {
      try {
        const latest = await waitForRunTerminal(cwd, record.runId);
        if (!latest) return;
        if (latest.background && latest.autoHandoff) {
          const latestResult = latest.results[0];
          const output = latestResult ? getFinalOutput(latestResult.messages) : "";
          const notices = [latestResult?.errorMessage, latest.statusReason, latestResult?.stderr?.trim() ? latestResult.stderr.trim() : ""]
            .filter(Boolean)
            .join("\n\n");
          const body = output
            ? `Summary:\n${output}${notices ? `\n\n${notices}` : ""}`
            : notices || "Use subagent result to inspect full output.";
          pi.sendMessage(
            {
              customType: "subagent-handoff",
              content: `Background ${latestResult?.agent || "subagent"} run ${latest.runId} completed with status ${latest.status}. ${body}`,
              display: true,
              details: { runId: latest.runId, status: latest.status, statusReason: latest.statusReason, artifactPath: latest.artifactPath },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      } finally {
        activeRuns.delete(record.runId);
      }
    })();
  });

}

export default function lifecycleSubagent(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run planner/developer/tester subagents with durable background lifecycle actions. Pass previousRunId on action=run to automatically carry a prior terminal run's final output into this run's task instead of relying on the lead to relay it manually.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const action = params.action;
      const agentScope = (params.agentScope ?? "both") as AgentScope;

      if (action === "catalog") {
        const discovery = discoverAgents(ctx.cwd, agentScope, ctx.sessionManager.getSessionId());
        const lines = [
          `Session: ${discovery.sessionId || "(none)"}`,
          `Profile: ${discovery.sessionProfileSource} | ${discovery.sessionProfilePath}`,
          ...(discovery.agents.length === 0
            ? ["No agents found."]
            : discovery.agents.map((agent) => {
                const runner = agent.runner || "pi";
                const model = agent.model || "default";
                return `${agent.name} (${agent.source}) - ${runner} | ${model}`;
              })),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            action,
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            sessionId: discovery.sessionId,
            sessionProfileSource: discovery.sessionProfileSource,
            sessionProfilePath: discovery.sessionProfilePath,
          } satisfies SubagentDetails,
        };
      }

      if (action === "status" || action === "result") {
        if (!params.runId) {
          return {
            content: [{ type: "text", text: "runId is required for status/result." }],
            isError: true,
          };
        }
        const record = loadRun(ctx.cwd, params.runId);
        if (!record) {
          return {
            content: [{ type: "text", text: `Unknown runId: ${params.runId}` }],
            isError: true,
          };
        }
        const output = record.results[0] ? getFinalOutput(record.results[0].messages) : "";
        return {
          content: [{ type: "text", text: action === "status"
            ? `${record.runId}: ${record.status}\nProfile: ${record.sessionProfileSource || "none"} | ${record.sessionProfilePath || "(unknown)"}`
            : output
              ? `${formatStatusLine(record.status, record.statusReason)}\n\n${output}`
              : `${formatStatusLine(record.status, record.statusReason)} Run ${record.runId} has no final output yet.` }],
          details: {
            action,
            runId: record.runId,
            mode: record.mode,
            status: record.status,
            agentScope: record.agentScope,
            projectAgentsDir: record.projectAgentsDir,
            sessionId: record.sessionId,
            sessionProfileSource: record.sessionProfileSource,
            sessionProfilePath: record.sessionProfilePath,
            previousRunId: record.previousRunId,
            artifactPath: record.artifactPath,
            results: record.results,
          } satisfies SubagentDetails,
        };
      }

      if (action === "cancel") {
        if (!params.runId) {
          return {
            content: [{ type: "text", text: "runId is required for cancel." }],
            isError: true,
          };
        }
        const record = loadRun(ctx.cwd, params.runId);
        if (!record) {
          return {
            content: [{ type: "text", text: `Unknown runId: ${params.runId}` }],
            isError: true,
          };
        }
        const active = activeRuns.get(params.runId);
        try {
          if (active?.child.pid) {
            active.child.kill("SIGTERM");
          } else if (record.pid) {
            process.kill(record.pid, "SIGTERM");
          }
        } catch {}
        record.status = "canceled";
        saveRun(record);
        return {
          content: [{ type: "text", text: `Canceled ${params.runId}` }],
          details: {
            action,
            runId: record.runId,
            status: record.status,
            sessionId: record.sessionId,
            sessionProfileSource: record.sessionProfileSource,
            sessionProfilePath: record.sessionProfilePath,
            previousRunId: record.previousRunId,
            artifactPath: record.artifactPath,
          } satisfies SubagentDetails,
        };
      }

      if (action === "cleanup") {
        if (params.runId) {
          const artifactPath = getArtifactPath(ctx.cwd, params.runId);
          if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);
          return {
            content: [{ type: "text", text: `Removed ${params.runId}` }],
            details: { action, runId: params.runId } satisfies SubagentDetails,
          };
        }
        const removed: string[] = [];
        for (const run of listRuns(ctx.cwd)) {
          if (run.status === "running") continue;
          try {
            fs.unlinkSync(run.artifactPath);
            removed.push(run.runId);
          } catch {}
        }
        return {
          content: [{ type: "text", text: removed.length ? `Removed ${removed.length} completed run artifacts.` : "No completed run artifacts to remove." }],
          details: { action } satisfies SubagentDetails,
        };
      }

      if (action !== "run") {
        return {
          content: [{ type: "text", text: `Unsupported action: ${action}` }],
          isError: true,
        };
      }

      if (!params.agent || !params.task) {
        return {
          content: [{ type: "text", text: "agent and task are required for action=run." }],
          isError: true,
        };
      }

      const discovery = discoverAgents(ctx.cwd, agentScope, ctx.sessionManager.getSessionId());
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
      if (!agent) {
        const available = discovery.agents.map((candidate) => candidate.name).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Unknown agent: ${params.agent}. Available: ${available}` }],
          isError: true,
        };
      }

      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      if (agent.source === "project" && confirmProjectAgents && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Run project-local agent?",
          `Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nOnly continue for trusted repositories.`,
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
            details: {
              action,
              agentScope,
              projectAgentsDir: discovery.projectAgentsDir,
            } satisfies SubagentDetails,
          };
        }
      }

      let effectiveTask = params.task;
      if (params.previousRunId) {
        const priorRecord = loadRun(ctx.cwd, params.previousRunId);
        if (!priorRecord) {
          return {
            content: [{ type: "text", text: `Unknown previousRunId: ${params.previousRunId}. Refusing to proceed without it rather than silently dropping the link.` }],
            isError: true,
          };
        }
        if (!isTerminalRunStatus(priorRecord.status)) {
          return {
            content: [{ type: "text", text: `previousRunId ${params.previousRunId} is still ${priorRecord.status}; wait for it to finish before linking it as context.` }],
            isError: true,
          };
        }
        const priorResult = priorRecord.results[0];
        const priorOutput = priorResult ? getFinalOutput(priorResult.messages) : "";
        effectiveTask = `Prior run context (run: ${params.previousRunId}, agent: ${priorResult?.agent ?? "unknown"}, status: ${priorRecord.status}):\n${priorOutput || "(no output captured)"}\n\n${params.task}`;
      }

      const runId = newRunId();
      const background = params.background ?? true;
      const autoHandoff = params.autoHandoff ?? true;
      const record = buildInitialRecord(
        ctx.cwd,
        runId,
        background,
        autoHandoff,
        agentScope,
        discovery.projectAgentsDir,
        discovery.sessionId,
        discovery.sessionProfileSource,
        discovery.sessionProfilePath,
        params.previousRunId,
      );
      saveRun(record);

      const liveUpdate = background ? undefined : onUpdate;
      await startRun(pi, ctx.cwd, agent, effectiveTask, record, liveUpdate);

      if (background) {
        return {
          content: [{ type: "text", text: `Started ${agent.name} in background. runId: ${runId}.${params.previousRunId ? ` linkedTo: ${params.previousRunId}.` : ""} autoHandoff: ${autoHandoff ? "enabled" : "disabled"}. profile: ${record.sessionProfileSource || "none"} | ${record.sessionProfilePath || "(unknown)"}` }],
          details: {
            action,
            runId,
            mode: record.mode,
            status: record.status,
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            sessionId: record.sessionId,
            sessionProfileSource: record.sessionProfileSource,
            sessionProfilePath: record.sessionProfilePath,
            previousRunId: record.previousRunId,
            artifactPath: record.artifactPath,
            results: record.results,
          } satisfies SubagentDetails,
        };
      }

      const active = activeRuns.get(runId);
      if (active?.child) {
        await new Promise<void>((resolve) => active.child.on("close", () => resolve()));
      }
      const finalRecord = (await waitForRunTerminal(ctx.cwd, runId)) || loadRun(ctx.cwd, runId) || record;
      const finalOutput = finalRecord.results[0] ? getFinalOutput(finalRecord.results[0].messages) : "";
      return {
        content: [{
          type: "text",
          text: finalOutput
            ? `${formatStatusLine(finalRecord.status, finalRecord.statusReason)}\n\n${finalOutput}`
            : `${formatStatusLine(finalRecord.status, finalRecord.statusReason)} Run ${runId} has no output.`,
        }],
        details: {
          action,
          runId,
          mode: finalRecord.mode,
          status: finalRecord.status,
          agentScope: finalRecord.agentScope,
          projectAgentsDir: finalRecord.projectAgentsDir,
          sessionId: finalRecord.sessionId,
          sessionProfileSource: finalRecord.sessionProfileSource,
          sessionProfilePath: finalRecord.sessionProfilePath,
          previousRunId: finalRecord.previousRunId,
          artifactPath: finalRecord.artifactPath,
          results: finalRecord.results,
        } satisfies SubagentDetails,
        isError: finalRecord.status === "failed",
      };
    },
  });

  pi.registerCommand("subagent-runs", {
    description: "List saved subagent runs",
    handler: async (_args, ctx) => {
      const runs = listRuns(ctx.cwd).slice(0, 20);
      if (runs.length === 0) {
        ctx.ui.notify("No subagent runs found.", "info");
        return;
      }
      ctx.ui.notify(
        runs.map((run) => `${run.runId}  ${run.status}  ${run.updatedAt}`).join("\n"),
        "info",
      );
    },
  });
}
