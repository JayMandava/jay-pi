import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appendHistoryEvent } from "./cycle-store.mjs";

// Code-enforced version of "Lead just doesn't invoke Developer before the
// plan is approved" — today that's a pure convention with nothing behind it
// but Lead's own discipline. This ties an explicit approval record to the
// exact approach.db row it approves (not just "some plan was approved at
// some point"), and lifecycle-subagent's `run` action refuses to spawn
// Developer unless the *latest* approach row has one.
//
// Deliberately tied to a specific row id, not just "has approval ever
// happened": if Planner revises the plan (a new approach row lands after a
// prior approval), that older approval must not silently keep authorizing
// Developer against a plan that no longer exists in that form.

function getApprovalsDbPath(cwd: string): string {
	return path.join(cwd, "data", "approvals.db");
}

function ensureApprovalsTable(dbPath: string): void {
	const sql = `CREATE TABLE IF NOT EXISTS approvals (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		approach_row_id INTEGER NOT NULL,
		approved_at TEXT NOT NULL
	);`;
	execFileSync("sqlite3", [dbPath, sql]);
}

function getLatestApproachRowId(cwd: string): number | null {
	const dbPath = path.join(cwd, "data", "approach.db");
	if (!fs.existsSync(dbPath)) return null;
	try {
		const out = execFileSync("sqlite3", [dbPath, "SELECT id FROM cycles ORDER BY id DESC LIMIT 1;"]).toString().trim();
		return out ? Number(out) : null;
	} catch {
		return null;
	}
}

// Exported so lifecycle-subagent's Developer-spawn guard can check the same
// thing this tool writes, without re-deriving the logic.
export function isApproachRowApproved(cwd: string, approachRowId: number): boolean {
	const dbPath = getApprovalsDbPath(cwd);
	if (!fs.existsSync(dbPath)) return false;
	try {
		const out = execFileSync("sqlite3", [dbPath, `SELECT 1 FROM approvals WHERE approach_row_id = ${approachRowId} LIMIT 1;`])
			.toString()
			.trim();
		return out === "1";
	} catch {
		return false;
	}
}

export { getLatestApproachRowId };

const ApprovePlanParams = Type.Object({
	approachRowId: Type.Optional(
		Type.Integer({ description: "The specific approach.db row id to approve. Defaults to the latest row if omitted." }),
	),
});

export default function planApproval(pi: ExtensionAPI) {
	pi.registerTool({
		name: "approve_plan",
		label: "Approve plan",
		description:
			"Record that the human has approved the plan in approach.db (the latest row, or a specific one via approachRowId) — this is what unblocks spawning the Developer subagent. Call this only after a real Grilling Discipline review with the human, never on a subagent's own say-so.",
		parameters: ApprovePlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "approve_plan requires an interactive session — a background subagent cannot self-approve a plan." }],
					isError: true,
				};
			}

			const rowId = params.approachRowId ?? getLatestApproachRowId(ctx.cwd);
			if (rowId === null) {
				return {
					content: [{ type: "text", text: "No approach.db row found to approve — Planner hasn't recorded a plan yet." }],
					isError: true,
				};
			}

			const dbPath = getApprovalsDbPath(ctx.cwd);
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
			ensureApprovalsTable(dbPath);
			const approvedAt = new Date().toISOString();
			execFileSync("sqlite3", [
				dbPath,
				`INSERT INTO approvals (approach_row_id, approved_at) VALUES (${rowId}, '${approvedAt}');`,
			]);

			appendHistoryEvent(ctx.cwd, { event: "plan_approved", approachRowId: rowId, approvedAt });

			return {
				content: [{ type: "text", text: `Approved approach.db row ${rowId} at ${approvedAt}. Developer can now be spawned for this plan.` }],
				details: { approachRowId: rowId, approvedAt },
			};
		},
	});
}
