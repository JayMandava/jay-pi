import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// Generic version of a pattern this harness leans on for any external system
// of record (Notion, Confluence, Linear, a wiki API, a ticket tracker,
// whatever your team actually uses): a write to it must never go out without
// a human seeing the literal payload first.
//
// Nothing is gated by default. Configure which tool calls count as a "write"
// via a small JSON file (see external-sink.example.json in this repo's
// config/ directory for the shape) — one entry per external sink, each
// naming a human-readable label and the exact MCP tool names it covers.
// Read-only tools (search/fetch/query/get-*) should never be listed here:
// misclassifying a read as a write is just an annoying extra prompt;
// misclassifying a write as a read silently defeats the whole gate.

interface GatedSink {
	label: string;
	tools: string[];
}

const CONFIG_PATH = process.env.PI_EXTERNAL_SINK_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "external-sink.json");
const MAX_PREVIEW_CHARS = 4000;

function loadGatedTools(): Map<string, string> {
	const byTool = new Map<string, string>();
	let raw: string;
	try {
		raw = fs.readFileSync(CONFIG_PATH, "utf8");
	} catch {
		return byTool; // no config file present = nothing gated
	}

	let sinks: GatedSink[];
	try {
		sinks = JSON.parse(raw);
	} catch {
		return byTool;
	}
	if (!Array.isArray(sinks)) return byTool;

	for (const sink of sinks) {
		if (!sink?.label || !Array.isArray(sink.tools)) continue;
		for (const tool of sink.tools) {
			if (typeof tool === "string") byTool.set(tool, sink.label);
		}
	}
	return byTool;
}

function formatInput(input: Record<string, unknown>): string {
	const json = JSON.stringify(input, null, 2);
	if (json.length <= MAX_PREVIEW_CHARS) return json;
	return `${json.slice(0, MAX_PREVIEW_CHARS)}\n... (truncated, ${json.length} chars total)`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
		// Read fresh on every call rather than caching at startup, so editing
		// the config file takes effect without restarting the session.
		const gatedTools = loadGatedTools();
		const label = gatedTools.get(event.toolName);
		if (!label) return {};

		// Background subagents run non-interactively (--mode json, no
		// dialog-capable UI) — there's no human to ask here. Rather than
		// silently letting the write through unreviewed, block it: the correct
		// flow is for them to draft the content and return it, so the
		// interactive lead session (which does have UI) is the one that
		// actually writes, gated by the confirm dialog below.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `${label} writes must go through the interactive lead session after human approval — draft the content and return it instead of writing directly.`,
			};
		}

		const approved = await ctx.ui.confirm(`Confirm ${label} write: ${event.toolName}`, formatInput(event.input));
		if (!approved) {
			return { block: true, reason: `Human did not approve this ${label} write.` };
		}
		return {};
	});
}
