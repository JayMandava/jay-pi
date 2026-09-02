import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Single source of truth for writing a lifecycle cycle record — used by both
// the pi-native `record_cycle` tool (cycle-records.ts) and the standalone MCP
// server (mcp/record-cycle-server/) that exposes the same capability to
// Claude-CLI-routed subagents, which have no path back into pi's own
// registered tools. Whichever caller invokes this, the write itself is
// identical: same schema, same thin-summary rejection, same
// role-derived-strictly-from-stage guarantee. Plain JS (not TS) so a bare
// `node` process (no pi, no type-stripping) can import it directly.

export const STAGE_TABLE = {
	approach: { db: "approach.db", defaultRole: "planner" },
	implementation: { db: "implementation.db", defaultRole: "developer" },
	feedback: { db: "feedback.db", defaultRole: "tester" },
	review: { db: "review.db", defaultRole: "lead" },
};

export const MIN_SUMMARY_CHARS = 40;

function quoteSqlString(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

function ensureTable(dbPath) {
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

/**
 * @param {{cwd: string, stage: string, summary: string, data?: unknown, cycleId?: string}} params
 * @returns {{ok: true, table: string, dbPath: string, rowId: number, stage: string, role: string, cycleId: string|null, createdAt: string} | {ok: false, reason: string}}
 */
export function writeCycleRecord({ cwd, stage, summary, data, cycleId }) {
	const stageInfo = STAGE_TABLE[stage];
	if (!stageInfo) {
		return { ok: false, reason: `Unknown stage: "${stage}". Valid stages: ${Object.keys(STAGE_TABLE).join(", ")}.` };
	}

	const trimmedSummary = (summary ?? "").trim();
	if (trimmedSummary.length < MIN_SUMMARY_CHARS) {
		return {
			ok: false,
			reason: `Rejected: summary is only ${trimmedSummary.length} chars (minimum ${MIN_SUMMARY_CHARS}). This usually means content was lost on the way in, not a limit to work around — resend the full summary, don't shrink it to fit.`,
		};
	}

	const dbDir = path.join(cwd, "data");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, stageInfo.db);
	ensureTable(dbPath);

	// role is derived strictly from stage, never a caller-supplied value —
	// stage implies role in this fixed lifecycle (approach/planner,
	// implementation/developer, feedback/tester, review/lead), and letting a
	// caller override it would let e.g. a Developer attribute its own
	// implementation row to "tester".
	const role = stageInfo.defaultRole;
	const payload = JSON.stringify(data ?? {});
	const createdAt = new Date().toISOString();
	const trimmedCycleId = typeof cycleId === "string" && cycleId.trim() ? cycleId.trim() : null;

	const insertSql = `INSERT INTO cycles (cycle_id, role, stage, summary, payload, created_at) VALUES (${
		trimmedCycleId ? quoteSqlString(trimmedCycleId) : "NULL"
	}, ${quoteSqlString(role)}, ${quoteSqlString(stage)}, ${quoteSqlString(trimmedSummary)}, ${quoteSqlString(payload)}, ${quoteSqlString(createdAt)});`;
	// last_insert_rowid() is scoped to the connection that did the insert — a
	// separate `sqlite3` invocation opens a new connection and always reports
	// 0. Run both statements in one invocation so they share a connection.
	const rowId = execFileSync("sqlite3", [dbPath, `${insertSql}\nSELECT last_insert_rowid();`]).toString().trim();

	return {
		ok: true,
		table: "cycles",
		dbPath: path.relative(cwd, dbPath),
		rowId: Number(rowId),
		stage,
		role,
		cycleId: trimmedCycleId,
		createdAt,
	};
}
