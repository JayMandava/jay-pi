import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { format } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// While pi's TUI is up it owns the terminal, but pi only intercepts console output in its
// non-interactive modes. Any package that calls console.log/warn/error in the TUI (pi-mcp-adapter
// prints OAuth URLs, connect failures and health-check errors this way) writes straight to the
// screen at the cursor — right under the editor bar — and pi's diff renderer never repaints
// those rows, so they pile up over the footer. This sends that output to a log file instead and
// surfaces only what the user must act on through pi's own notifier, which wraps correctly.

const LEVELS = ["log", "info", "debug", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
type ConsoleFn = (...args: unknown[]) => void;

const STATE_KEY = Symbol.for("pi-harness.tui-console-guard");
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const SUMMARY_BATCH_MS = 1_500;
const SUMMARY_MIN_INTERVAL_MS = 60_000;
// Output the user has to act on (a login URL they must open): shown at once, not just logged.
const SHOW_IMMEDIATELY = /Open this URL/i;

type Handler = (level: Level, args: unknown[]) => void;
type GuardState = { originals: Record<Level, ConsoleFn>; handle: Handler };

function getState(): GuardState | undefined {
	return (globalThis as Record<symbol, unknown>)[STATE_KEY] as GuardState | undefined;
}

// The wrappers read the current handler from shared state on every call, so after a /reload the
// new extension instance takes over the wrappers already installed instead of wrapping them again.
function install(handle: Handler): void {
	const existing = getState();
	if (existing) {
		existing.handle = handle;
		return;
	}
	const originals = {} as Record<Level, ConsoleFn>;
	for (const level of LEVELS) originals[level] = console[level] as ConsoleFn;
	(globalThis as Record<symbol, unknown>)[STATE_KEY] = { originals, handle } satisfies GuardState;
	for (const level of LEVELS) {
		console[level] = ((...args: unknown[]) => {
			getState()?.handle(level, args);
		}) as ConsoleFn;
	}
}

function restore(): void {
	const state = getState();
	if (!state) return;
	for (const level of LEVELS) console[level] = state.originals[level] as never;
	delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
}

function logFilePath(): string {
	return path.join(os.homedir(), ".pi", "agent", "logs", "console.log");
}

function writeLog(level: Level, text: string): void {
	try {
		const file = logFilePath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
		} catch {
			// no log file yet
		}
		fs.appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
	} catch {
		// Logging must never be able to break the code that called console.*.
	}
}

function firstLine(text: string, max: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function createHandler(getCtx: () => ExtensionContext | undefined): Handler {
	let pendingErrors = 0;
	let latestError = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSummaryAt = 0;

	const notify = (message: string, type: "info" | "warning" | "error") => {
		try {
			getCtx()?.ui.notify(message, type);
		} catch {
			// The captured context goes stale when the session is replaced; the log still has it.
		}
	};

	const flushSummary = () => {
		timer = undefined;
		if (pendingErrors === 0) return;
		const count = pendingErrors;
		pendingErrors = 0;
		lastSummaryAt = Date.now();
		notify(
			`${count} background error${count === 1 ? "" : "s"} logged (latest: ${firstLine(latestError, 120)}). Full log: ~/.pi/agent/logs/console.log`,
			"warning",
		);
	};

	return (level, args) => {
		let text: string;
		try {
			text = format(...args);
		} catch {
			text = "(unprintable console arguments)";
		}
		writeLog(level, text);

		if (SHOW_IMMEDIATELY.test(text)) {
			notify(text, "info");
			return;
		}
		if (level === "error") {
			pendingErrors += 1;
			latestError = text;
			if (!timer) {
				const wait = Math.max(SUMMARY_BATCH_MS, SUMMARY_MIN_INTERVAL_MS - (Date.now() - lastSummaryAt));
				timer = setTimeout(flushSummary, wait);
				timer.unref?.();
			}
		}
	};
}

export default function tuiConsoleGuard(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let myHandler: Handler | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// print/rpc modes already redirect or own console output; only the interactive TUI needs this.
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		myHandler = createHandler(() => currentCtx);
		install(myHandler);
	});

	pi.on("session_shutdown", async () => {
		// Only undo our own install: on /reload the new instance may already have taken over.
		if (myHandler && getState()?.handle === myHandler) restore();
		currentCtx = undefined;
		myHandler = undefined;
	});
}
