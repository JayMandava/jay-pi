import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

const STAGE_TABLE: Record<string, { db: string; defaultRole: string }> = {
	approach: { db: "approach.db", defaultRole: "planner" },
	implementation: { db: "implementation.db", defaultRole: "developer" },
	feedback: { db: "feedback.db", defaultRole: "tester" },
	review: { db: "review.db", defaultRole: "lead" },
};

const MIN_SUMMARY_CHARS = 40;

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

function quoteSqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function ensureTable(dbPath: string): void {
	const sql = `CREATE TABLE IF NOT EXISTS cycles (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		cycle_id TEXT,
		role TEXT NOT NULL,
		stage TEXT NOT NULL,
		summary TEXT NOT NULL,
		payload TEXT NOT NULL,
		created_at TEXT NOT NULL
	);`;
	execFileSync("sqlite3", [dbPath, sql]);
}

export default function cycleRecords(pi: ExtensionAPI) {
	pi.registerTool({
		name: "record_cycle",
		label: "Record cycle",
		description:
			"Write a structured record to the lifecycle DB for the current stage (approach/implementation/feedback/review) instead of freehand sqlite3. This is the machine-verifiable record of what a role produced — the lead checks the message trace for an actual call to this tool, not your closing summary, to decide whether the stage was really recorded. Writing an equivalent row yourself via bash/sqlite3 does not count, and asserting in your final message that this tool was called when it was not is a critical failure, not a shortcut.",
		parameters: RecordCycleParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const summary = params.summary.trim();
			if (summary.length < MIN_SUMMARY_CHARS) {
				return {
					content: [
						{
							type: "text",
							text: `Rejected: summary is only ${summary.length} chars (minimum ${MIN_SUMMARY_CHARS}). This usually means content was lost on the way in, not a limit to work around — resend the full summary, don't shrink it to fit.`,
						},
					],
					isError: true,
				};
			}

			const stageInfo = STAGE_TABLE[params.stage];
			const dbDir = path.join(ctx.cwd, "data");
			fs.mkdirSync(dbDir, { recursive: true });
			const dbPath = path.join(dbDir, stageInfo.db);
			ensureTable(dbPath);

			// role is derived strictly from stage, never a caller-supplied value —
			// stage implies role in this fixed lifecycle (approach/planner,
			// implementation/developer, feedback/tester, review/lead), and letting
			// a caller override it would let e.g. a Developer attribute its own
			// implementation row to "tester".
			const role = stageInfo.defaultRole;
			const payload = JSON.stringify(params.data ?? {});
			const createdAt = new Date().toISOString();
			const cycleId = params.cycleId?.trim() ?? null;

			const insertSql = `INSERT INTO cycles (cycle_id, role, stage, summary, payload, created_at) VALUES (${
				cycleId ? quoteSqlString(cycleId) : "NULL"
			}, ${quoteSqlString(role)}, ${quoteSqlString(params.stage)}, ${quoteSqlString(summary)}, ${quoteSqlString(payload)}, ${quoteSqlString(createdAt)});`;
			// last_insert_rowid() is scoped to the connection that did the insert —
			// a separate `sqlite3` invocation opens a new connection and always
			// reports 0. Run both statements in one invocation so they share a
			// connection.
			const rowId = execFileSync("sqlite3", [dbPath, `${insertSql}\nSELECT last_insert_rowid();`]).toString().trim();

			return {
				content: [
					{
						type: "text",
						text: `Recorded ${params.stage} cycle row ${rowId} in data/${stageInfo.db}${cycleId ? ` (cycle ${cycleId})` : ""}.`,
					},
				],
				details: {
					table: "cycles",
					dbPath: path.relative(ctx.cwd, dbPath),
					rowId: Number(rowId),
					stage: params.stage,
					role,
					cycleId,
					createdAt,
				},
			};
		},
	});
}
