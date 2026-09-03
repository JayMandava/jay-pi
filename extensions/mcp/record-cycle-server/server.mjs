#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { MIN_SUMMARY_CHARS, STAGE_TABLE, writeCycleRecord } from "../../cycle-store.mjs";

// Standalone MCP server exposing the exact same record_cycle capability the
// pi-native `subagent` tool gets (extensions/cycle-records.ts) — for
// Claude-CLI-routed subagents, which run as a bare `claude -p` subprocess
// with no path back into any pi-registered tool. Both share cycle-store.mjs
// so the write itself (schema, thin-summary rejection, role-from-stage) is
// identical regardless of which runner a subagent used.
//
// The tool is named "record_cycle" here; Claude Code exposes MCP tools under
// a server-name-prefixed identifier (mcp__<server>__<tool>), so
// lifecycle-subagent's completion check matches on a suffix, not an exact
// name — see hasSuccessfulCycleRecord in lifecycle-subagent/index.ts.
//
// Runs with cwd inherited from the `claude` process that spawns it (set via
// spawnClaudeAgent's own {cwd} option), so writeCycleRecord's cwd-relative
// data/ path resolves to the actual subagent run's working directory.

const server = new Server({ name: "record-cycle", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "record_cycle",
			description:
				"Write a structured record to the lifecycle DB for the current stage (approach/implementation/feedback/review) instead of freehand sqlite3. This is the machine-verifiable record of what a role produced. Writing an equivalent row yourself via bash/sqlite3 does not count, and asserting in your final message that this tool was called when it was not is a critical failure, not a shortcut.",
			inputSchema: {
				type: "object",
				properties: {
					stage: {
						type: "string",
						enum: Object.keys(STAGE_TABLE),
						description: "Which lifecycle DB this record belongs to",
					},
					cycleId: {
						type: "string",
						description: "Story/ticket id plus revision suffix, e.g. US-13647-R1. Recommended once a project has adopted it; fine to omit during early/informal adoption.",
					},
					summary: {
						type: "string",
						description: `One-paragraph human-readable summary of this record (minimum ${MIN_SUMMARY_CHARS} characters — a thin summary is rejected).`,
					},
					data: {
						description: "Any additional structured fields for this stage (assumptions, steps, risks, issues, verdict, etc.) — kept free-form on purpose, this isn't meant to be a rigid schema.",
					},
				},
				required: ["stage", "summary"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "record_cycle") {
		return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
	}

	// writeCycleRecord shells out to the sqlite3 CLI — an unexpected failure
	// there (not found, permission denied, disk full, etc.) must not be
	// allowed to throw uncaught out of this handler: a single bad call
	// crashing the whole server would take down every future record_cycle
	// call for the rest of the session, not just this one.
	try {
		const args = request.params.arguments ?? {};
		const result = writeCycleRecord({
			cwd: process.cwd(),
			stage: args.stage,
			summary: args.summary,
			data: args.data,
			cycleId: args.cycleId,
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
		};
	} catch (error) {
		return { content: [{ type: "text", text: `record_cycle failed unexpectedly: ${error?.message ?? String(error)}` }], isError: true };
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
