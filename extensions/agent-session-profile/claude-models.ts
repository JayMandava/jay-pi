import { spawn } from "node:child_process";
import * as os from "node:os";

export interface ClaudeCliModel {
  /** What `claude --model` accepts for this entry (an alias like "sonnet", or a full id). */
  value: string;
  /** The concrete model id the entry resolves to right now. */
  resolvedModel: string;
  displayName: string;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
}

function parseModels(raw: unknown[]): ClaudeCliModel[] {
  const models: ClaudeCliModel[] = [];
  for (const entry of raw) {
    const item = entry as { value?: unknown; resolvedModel?: unknown; displayName?: unknown };
    if (typeof item.value !== "string" || typeof item.resolvedModel !== "string") {
      continue;
    }
    models.push({
      value: item.value,
      resolvedModel: item.resolvedModel,
      displayName: typeof item.displayName === "string" ? item.displayName : item.resolvedModel,
    });
  }
  return models;
}

// Asks the installed `claude` CLI which models it can actually run — the same list its own
// /model picker shows, so it follows the CLI version and the signed-in account instead of a
// list somebody has to remember to edit. Uses the stream-json control protocol's `initialize`
// request: it answers in a fraction of a second and makes no model call. Runs from a temp
// directory with no MCP servers and no session file so it doesn't pick up project hooks/servers
// or leave a transcript behind. Resolves null on any failure so callers can fall back.
export function queryClaudeCliModels(timeoutMs = 10_000): Promise<ClaudeCliModel[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "claude",
        [
          "-p",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--strict-mcp-config",
        ],
        { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }

    const finish = (models: ClaudeCliModel[] | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(models && models.length > 0 ? models : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin?.on("error", () => finish(null));

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) {
          continue;
        }
        try {
          const message = JSON.parse(line);
          if (message?.type === "control_response") {
            const models = message.response?.response?.models;
            finish(Array.isArray(models) ? parseModels(models) : null);
            return;
          }
        } catch {
          // Not a JSON line (e.g. a stray warning) — keep reading.
        }
      }
    });

    child.stdin?.write(
      JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n",
    );
  });
}

// Turns the CLI's list into picker rows. Keyed by the resolved id so `default` and `sonnet`
// (the same model under two names) show once, and the saved model stays selectable even if the
// CLI no longer lists it. Falls back to the given presets when the CLI couldn't be asked.
export function buildClaudeModelOptions(
  cliModels: ClaudeCliModel[] | null,
  fallbackPresets: readonly string[],
  selectedModel: string,
): ClaudeModelOption[] {
  const rows = new Map<string, string>();

  if (cliModels) {
    for (const model of cliModels) {
      if (model.value === "default" || rows.has(model.resolvedModel)) {
        continue;
      }
      rows.set(model.resolvedModel, `${model.displayName} (${model.resolvedModel})`);
    }
  } else {
    for (const preset of fallbackPresets) {
      rows.set(preset, preset);
    }
  }

  if (selectedModel && !rows.has(selectedModel)) {
    rows.set(selectedModel, selectedModel);
  }

  return Array.from(rows, ([id, label]) => ({
    id,
    label: id === selectedModel ? `${label} (current)` : label,
  }));
}
