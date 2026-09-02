import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MIN_SUMMARY_CHARS, writeCycleRecord } from "./cycle-store.mjs";

// Structured, tool-mediated writes for the plan/implement/check/review cycle
// DBs, replacing freehand `sqlite3` calls the model used to construct itself.
// Two things this buys, adapted from a reviewer-runtime design pattern:
//
// 1. Payload vs narration: the DB row is written by this tool, not asserted
//    by the model's closing prose. lifecycle-subagent scans a run's messages
//    for a successful `record_cycle` tool result and knows a stage was
//    actually recorded, independent of what the model claims it did.
// 2. Recover, don't shrink: a payload rejected for being too thin means
//    content was lost on the way in, not a length limit to trim around —
//    say so explicitly rather than letting a weak model quietly truncate its
//    own findings to get past the gate.
//
// The actual write lives in cycle-store.mjs, shared with the standalone MCP
// server (mcp/record-cycle-server/) that exposes this same capability to
// Claude-CLI-routed subagents — they have no path back into a pi-registered
// tool like this one, so they reach the identical write through MCP instead.

const RecordCycleParams = Type.Object({
	stage: StringEnum(["approach", "implementation", "feedback", "review"] as const, {
		description: "Which lifecycle DB this record belongs to",
	}),
	cycleId: Type.Optional(
		Type.String({
			description:
				"Story/ticket id plus revision suffix, e.g. US-13647-R1 (see the Plan identity rule in AGENTS.md). Recommended once a project has adopted it; fine to omit during early/informal adoption.",
		}),
	),
	summary: Type.String({
		description: `One-paragraph human-readable summary of this record (minimum ${MIN_SUMMARY_CHARS} characters — a thin summary is rejected).`,
	}),
	data: Type.Optional(Type.Unknown({ description: "Any additional structured fields for this stage (assumptions, steps, risks, issues, verdict, etc.) — kept free-form on purpose, this isn't meant to be a rigid schema." })),
});

export default function cycleRecords(pi: ExtensionAPI) {
	pi.registerTool({
		name: "record_cycle",
		label: "Record cycle",
		description:
			"Write a structured record to the lifecycle DB for the current stage (approach/implementation/feedback/review) instead of freehand sqlite3. This is the machine-verifiable record of what a role produced — the lead checks the message trace for an actual call to this tool, not your closing summary, to decide whether the stage was really recorded. Writing an equivalent row yourself via bash/sqlite3 does not count, and asserting in your final message that this tool was called when it was not is a critical failure, not a shortcut.",
		parameters: RecordCycleParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = writeCycleRecord({
				cwd: ctx.cwd,
				stage: params.stage,
				summary: params.summary,
				data: params.data,
				cycleId: params.cycleId,
			});

			if (!result.ok) {
				return { content: [{ type: "text", text: result.reason }], isError: true };
			}

			return {
				content: [
					{
						type: "text",
						text: `Recorded ${result.stage} cycle row ${result.rowId} in ${result.dbPath}${result.cycleId ? ` (cycle ${result.cycleId})` : ""}.`,
					},
				],
				details: result,
			};
		},
	});
}
