import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// Live peek into a running background subagent (Hermione/Harry/Snape) while
// the lead is otherwise idle waiting on it — a plain status ticker, not a
// scrollback log: a short label plus the last few things that happened.

const WIDGET_KEY = "subagent-status";
const RUNS_DIR = path.join("data", "subagent-runs");
const POLL_MS = 700;
// Fixed-height scroll window, not a growing log — new events push old ones
// off the top the same way `tail -f` would, so this can't grow to dominate
// the screen no matter how long a run or how many concurrent runs there are.
// Kept tight (a live ticker, not a scrollback log) — the point is "what's
// happening right now," not a history you'd want to read back through.
const MAX_FEED_LINES = 3;

interface FeedEvent {
	timestamp: number;
	role: string;
	line: string;
}

// Common tool arg fields worth surfacing verbatim so "what's cooking" reads
// as e.g. "🔧 bash: npm test" instead of just "🔧 bash".
const ARG_PREVIEW_FIELDS = ["command", "file_path", "path", "pattern", "query", "url"];

function previewArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	for (const field of ARG_PREVIEW_FIELDS) {
		const value = (args as Record<string, unknown>)[field];
		// Multi-line commands (a python heredoc, a long bash loop) contain real
		// embedded newlines — collapse to one line same as messageEventLine does
		// for text/thinking, or a single "event" prints as many terminal rows.
		if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
	}
	return "";
}

// Turns one message into one feed line — a tool call in flight, a tool
// result just landed, or an assistant text/thinking chunk. Returns null for
// messages that don't carry a displayable event (e.g. the user turn itself).
function messageEventLine(message: Record<string, unknown>): string | null {
	if (message.role === "toolResult") {
		const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
		return `✓ ${toolName} done`;
	}

	if (message.role === "assistant" && Array.isArray(message.content)) {
		const toolCall = message.content.find((part: any) => part?.type === "toolCall");
		if (toolCall) {
			const preview = previewArgs(toolCall.arguments);
			return `🔧 ${toolCall.name}${preview ? `: ${preview}` : ""}`;
		}
		const text = message.content.find((part: any) => part?.type === "text")?.text;
		if (typeof text === "string" && text.trim()) return text.replace(/\s+/g, " ").trim();
		const thinking = message.content.find((part: any) => part?.type === "thinking")?.thinking;
		if (typeof thinking === "string" && thinking.trim()) return `💭 ${thinking.replace(/\s+/g, " ").trim()}`;
	}

	return null;
}

// Reads the same data/subagent-runs/*.json records the "subagent" tool and
// /subagent-runs command already write/read, so this stays in sync with real
// run state without needing any changes to lifecycle-subagent itself. Those
// records are updated on every message/tool event as the run progresses (not
// just at completion), so replaying the full message list on every poll and
// taking the tail is a genuine scrolling feed, not just a repeated snapshot.
//
// data/subagent-runs is scoped to the project (cwd), not the session — two
// sessions open in the same project share that folder. Each run record also
// carries the sessionId of whichever session started it, so filter on that
// to keep this confined to the session that actually kicked off the run.
function readFeed(cwd: string, sessionId: string | undefined): { roles: string[]; events: FeedEvent[] } {
	const dir = path.join(cwd, RUNS_DIR);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return { roles: [], events: [] };
	}

	const roles = new Set<string>();
	const events: FeedEvent[] = [];
	for (const file of files) {
		try {
			const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
			if (record?.status !== "running") continue;
			if (record?.sessionId !== sessionId) continue;
			const agent = record?.results?.[0]?.agent;
			const role = typeof agent === "string" && agent ? agent : "subagent";
			roles.add(role);

			const messages: unknown[] = record?.results?.[0]?.messages ?? [];
			let any = false;
			for (const message of messages) {
				if (!message || typeof message !== "object") continue;
				const line = messageEventLine(message as Record<string, unknown>);
				if (!line) continue;
				any = true;
				const timestamp = typeof (message as any).timestamp === "number" ? (message as any).timestamp : Date.now();
				events.push({ timestamp, role, line });
			}
			if (!any) {
				// No displayable event yet — still show the run is alive rather than
				// leaving it silently absent from the feed until its first tool call.
				events.push({ timestamp: record?.updatedAt ? Date.parse(record.updatedAt) : Date.now(), role, line: "starting…" });
			}
		} catch {
			// ignore unreadable/partially-written run files
		}
	}
	events.sort((a, b) => a.timestamp - b.timestamp);
	return { roles: Array.from(roles).sort(), events };
}

function renderStatus(theme: Theme, width: number, roles: string[], events: FeedEvent[]): string[] {
	const label = `Running: ${roles.join(", ")}`;

	// Newest event at the bottom, oldest at the top, within the fixed window —
	// the same reading direction as a scrolling terminal log.
	const feedLines = events.slice(-MAX_FEED_LINES).map((event) => {
		const line = truncateToWidth(`  ${event.role}: ${event.line}`, width, "…");
		return theme.fg("muted", line);
	});
	// Pad to a constant total height. The in-place redraw for this widget slot
	// assumes a fixed line count; a height that shrinks between polls leaves
	// the previous, taller frame's trailing lines uncleared, which then get
	// baked into scrollback as the transcript scrolls.
	while (feedLines.length < MAX_FEED_LINES) feedLines.push("");

	return [theme.fg("accent", label), ...feedLines];
}

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let widgetActive = false;
	let currentRoles: string[] = [];
	let currentEvents: FeedEvent[] = [];
	let requestRender: (() => void) | undefined;

	function stopWidget(ctx: ExtensionContext) {
		widgetActive = false;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function startWidget(ctx: ExtensionContext) {
		if (widgetActive) return;
		widgetActive = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: TUI, theme: Theme) => {
				requestRender = () => tui.requestRender();
				return {
					render(width: number): string[] {
						return renderStatus(theme, width, currentRoles, currentEvents);
					},
					invalidate() {},
					dispose() {
						requestRender = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		pollTimer = setInterval(() => {
			const { roles, events } = readFeed(ctx.cwd, ctx.sessionManager.getSessionId());
			const wasActive = currentRoles.length > 0;
			currentRoles = roles;
			currentEvents = events;
			if (roles.length > 0 && !wasActive) {
				startWidget(ctx);
			} else if (roles.length === 0 && wasActive) {
				stopWidget(ctx);
			} else if (roles.length > 0) {
				// Already showing — just refresh with the latest polled data,
				// no separate fast timer driving redraws between polls.
				requestRender?.();
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		widgetActive = false;
		requestRender = undefined;
	});
}
