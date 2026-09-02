import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WatchdogState = {
  active: boolean;
  warned: boolean;
  aborted: boolean;
  lastProgressAt: number;
};

const DEFAULT_WARN_MS = 45_000;
const DEFAULT_ABORT_MS = 60_000;
const STATUS_KEY = "lead-idle-timeout";

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readEnabled(): boolean {
  const raw = process.env.PI_LEAD_IDLE_TIMEOUT_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

function isLeadSession(ctx: ExtensionContext): boolean {
  return ctx.hasUI && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

export default function leadIdleTimeout(pi: ExtensionAPI) {
  const enabled = readEnabled();
  const warnMs = readNumber("PI_LEAD_IDLE_TIMEOUT_WARN_MS", DEFAULT_WARN_MS);
  const abortMs = Math.max(readNumber("PI_LEAD_IDLE_TIMEOUT_ABORT_MS", DEFAULT_ABORT_MS), warnMs + 1_000);

  let currentCtx: ExtensionContext | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let leadSession = false;
  let state: WatchdogState = {
    active: false,
    warned: false,
    aborted: false,
    lastProgressAt: Date.now(),
  };

  const clearWarningUi = () => {
    currentCtx?.ui.setStatus(STATUS_KEY, undefined);
  };

  const stopWatchdog = () => {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
    state.active = false;
    state.warned = false;
    state.aborted = false;
    clearWarningUi();
  };

  const markProgress = () => {
    if (!leadSession) return;
    state.lastProgressAt = Date.now();
    state.warned = false;
    clearWarningUi();
  };

  const ensureWatchdog = () => {
    if (!enabled || !leadSession || watchdog) return;
    watchdog = setInterval(() => {
      if (!currentCtx || !state.active || currentCtx.isIdle()) return;

      const idleFor = Date.now() - state.lastProgressAt;
      if (!state.warned && idleFor >= warnMs) {
        state.warned = true;
        const remaining = Math.max(0, abortMs - idleFor);
        currentCtx.ui.setStatus(STATUS_KEY, `Lead idle timeout: aborting in ${formatSeconds(remaining)}`);
        currentCtx.ui.notify(
          `Lead agent has made no meaningful progress for ${formatSeconds(idleFor)}. Aborting in ${formatSeconds(remaining)} if it stays stuck.`,
          "warning",
        );
        return;
      }

      if (!state.aborted && idleFor >= abortMs) {
        state.aborted = true;
        currentCtx.ui.setStatus(STATUS_KEY, "Lead idle timeout: aborting current run");
        currentCtx.ui.notify(
          `Lead agent made no meaningful progress for ${formatSeconds(idleFor)}. Aborting the current run.`,
          "error",
        );
        currentCtx.abort();
      }
    }, 1_000);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    leadSession = enabled && isLeadSession(ctx);
    stopWatchdog();
    if (leadSession) {
      ensureWatchdog();
    }
  });

  pi.on("session_shutdown", async () => {
    stopWatchdog();
    currentCtx = undefined;
    leadSession = false;
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (!leadSession) return;
    state.active = true;
    state.aborted = false;
    markProgress();
    ensureWatchdog();
  });

  pi.on("agent_end", async () => {
    state.active = false;
    state.warned = false;
    state.aborted = false;
    clearWarningUi();
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("message_update", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("tool_execution_update", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    markProgress();
  });
}
