import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, TextContent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// Optional sideline check: after Tester writes its "feedback" record_cycle
// row, ask TypeSafe's Jev (https://typesafe.ai — a calibrated Choice/Score/
// Noul classifier, not a chat model) three independent questions mirroring
// Tester's own checklist (plan fidelity / drift / risk-evidence coverage) —
// built only from the plan + diff, never from Tester's own summary, so
// agreement/disagreement is a real signal, not circular. No anchoring risk
// either way: Tester's verdict is already durably written via record_cycle
// *before* this ever runs, so seeing Jev's matrix afterward can't change
// what was recorded — it can only get appended to Tester's own report for a
// human to weigh.
//
// Fully optional and inert by default: this does nothing unless you set
// JEV_API_KEY yourself (get one at https://console.typesafe.ai). No key,
// no calls, no cost, no behavior change — see the "Optional: Jev cross-check"
// section in README.md.

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_ENV_FILE = path.join(os.homedir(), ".pi", ".env");
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 8000;
const MAX_DIFF_CHARS = 20000;

type JevMatrix = {
	plan_fidelity: number | null;
	drift: number | null;
	risk_coverage: number | null;
	raw: unknown;
};

// Checks process.env first (the normal way to configure a secret for any
// CLI), then falls back to a `JEV_API_KEY=...` line in ~/.pi/.env for anyone
// who keeps secrets there instead of exporting them — either is fine, this
// never requires both.
function readJevApiKey(): string | null {
	const fromEnv = process.env.JEV_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const raw = fs.readFileSync(JEV_ENV_FILE, "utf8");
		for (const line of raw.split("\n")) {
			const match = line.match(/^\s*JEV_API_KEY\s*=\s*(.+?)\s*$/);
			if (match) return match[1].replace(/^["']|["']$/g, "");
		}
	} catch {
		// no ~/.pi/.env, or unreadable — checked at call time so a missing key
		// degrades to "skip this cycle's parallel check", not an extension load
		// crash.
	}
	return null;
}

function getGitDiff(cwd: string): string {
	try {
		const unstaged = execFileSync("git", ["diff", "HEAD"], { cwd, maxBuffer: 10 * 1024 * 1024 }).toString();
		if (unstaged.trim()) return unstaged;
		return execFileSync("git", ["diff"], { cwd, maxBuffer: 10 * 1024 * 1024 }).toString();
	} catch {
		return ""; // not a git repo, or no changes — Jev still gets asked, just without a diff
	}
}

function getLatestApproachSummary(cwd: string, cycleId: string | null): string {
	const dbPath = path.join(cwd, "data", "approach.db");
	if (!fs.existsSync(dbPath)) return "";
	try {
		const query = cycleId
			? `SELECT summary FROM cycles WHERE cycle_id = '${cycleId.replace(/'/g, "''")}' ORDER BY id DESC LIMIT 1;`
			: `SELECT summary FROM cycles ORDER BY id DESC LIMIT 1;`;
		return execFileSync("sqlite3", [dbPath, query]).toString().trim();
	} catch {
		return "";
	}
}

function quoteSql(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function ensureLogTable(dbPath: string): void {
	const sql = `CREATE TABLE IF NOT EXISTS jev_checks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		cycle_id TEXT,
		tester_row_id INTEGER,
		tester_summary TEXT NOT NULL,
		tester_data TEXT,
		jev_plan_fidelity REAL,
		jev_drift REAL,
		jev_risk_coverage REAL,
		jev_raw TEXT,
		created_at TEXT NOT NULL
	);`;
	execFileSync("sqlite3", [dbPath, sql]);
}

function logResult(
	cwd: string,
	row: {
		cycleId: string | null;
		testerRowId: number;
		testerSummary: string;
		testerData: unknown;
		matrix: JevMatrix;
	},
): void {
	const dbDir = path.join(cwd, "data");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, "jev-parallel-check.db");
	ensureLogTable(dbPath);
	const num = (value: number | null) => (value === null ? "NULL" : String(value));
	const sql = `INSERT INTO jev_checks (cycle_id, tester_row_id, tester_summary, tester_data, jev_plan_fidelity, jev_drift, jev_risk_coverage, jev_raw, created_at) VALUES (${
		row.cycleId ? quoteSql(row.cycleId) : "NULL"
	}, ${row.testerRowId}, ${quoteSql(row.testerSummary)}, ${quoteSql(JSON.stringify(row.testerData ?? null))}, ${num(
		row.matrix.plan_fidelity,
	)}, ${num(row.matrix.drift)}, ${num(row.matrix.risk_coverage)}, ${quoteSql(JSON.stringify(row.matrix.raw ?? null))}, ${quoteSql(
		new Date().toISOString(),
	)});`;
	execFileSync("sqlite3", [dbPath, sql]);
}

function formatMatrixTable(matrix: JevMatrix): string {
	const row = (label: string, value: number | null, reading: string) =>
		`${label.padEnd(15)} ${(value === null ? "n/a" : value.toFixed(2)).padEnd(6)} ${reading}`;
	return [
		"[Jev cross-check — informational only, independent of this record; does not change the verdict above]",
		row("plan_fidelity", matrix.plan_fidelity, "near 1 = diff satisfies the plan"),
		row("drift", matrix.drift, "near 1 = diff deviates from the approved approach"),
		row("risk_coverage", matrix.risk_coverage, "near 1 = material risk left unaddressed"),
	].join("\n");
}

async function queryJevMatrix(cwd: string, cycleId: string | null): Promise<JevMatrix | null> {
	const apiKey = readJevApiKey();
	if (!apiKey) return null; // not configured — silently skip, this is opt-in, not a hard dependency

	const planSummary = getLatestApproachSummary(cwd, cycleId);
	let diff = getGitDiff(cwd);
	let truncated = false;
	if (diff.length > MAX_DIFF_CHARS) {
		diff = diff.slice(0, MAX_DIFF_CHARS);
		truncated = true;
	}

	// Deliberately excludes Tester's own summary/verdict — Jev needs to judge
	// from the same source material Tester had, not from Tester's account of
	// it, or agreement between the two would be circular rather than a real
	// second opinion.
	const state = [
		planSummary ? `Approved plan summary:\n${planSummary}` : "(no approach record found for this cycle)",
		diff
			? `Code diff being reviewed:\n${diff}${truncated ? "\n...[diff truncated for length]" : ""}`
			: "(no git diff available — not a git repo, or no working-tree changes)",
	].join("\n\n---\n\n");

	let response: Response;
	try {
		response = await fetch(JEV_API_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			body: JSON.stringify({
				state,
				model: JEV_MODEL,
				questions: {
					plan_fidelity: {
						type: "noul",
						instructions:
							"Does the code diff fully and correctly implement the approved plan, with no material gaps? Judge only from the plan and diff given here.",
					},
					drift: {
						type: "noul",
						instructions:
							"Does the diff deviate from the approach the plan actually specified (different mechanism, scope, or files than what was approved), even if the end result looks similar?",
					},
					risk_coverage: {
						type: "noul",
						instructions:
							"Does the diff leave material risk unaddressed — missing error handling, untested edge cases, or a risk the plan called out that the diff doesn't actually cover?",
					},
				},
			}),
		});
	} catch (error) {
		console.error("[jev-parallel-check] request failed or timed out:", error);
		return null;
	}

	if (!response.ok) {
		console.error(`[jev-parallel-check] API call failed: ${response.status} ${await response.text().catch(() => "")}`);
		return null;
	}

	const body = (await response.json()) as {
		answers?: Record<"plan_fidelity" | "drift" | "risk_coverage", { noul?: number } | undefined>;
	};
	return {
		plan_fidelity: body.answers?.plan_fidelity?.noul ?? null,
		drift: body.answers?.drift?.noul ?? null,
		risk_coverage: body.answers?.risk_coverage?.noul ?? null,
		raw: body,
	};
}

export default function jevParallelCheck(pi: ExtensionAPI) {
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		if (event.toolName !== "record_cycle" || event.isError) return {};
		const input = event.input as Record<string, unknown>;
		if (input?.stage !== "feedback") return {};

		const details = event.details as Record<string, unknown> | undefined;
		const cycleId = ((details?.cycleId ?? input.cycleId) as string | null | undefined) ?? null;
		const testerRowId = (details?.rowId as number | undefined) ?? -1;
		const testerSummary = (input.summary as string | undefined) ?? "";

		const matrix = await queryJevMatrix(ctx.cwd, cycleId).catch((error) => {
			console.error("[jev-parallel-check] unexpected failure:", error);
			return null;
		});
		if (!matrix) return {}; // not configured, or the call failed/timed out — leave the tool result untouched

		try {
			logResult(ctx.cwd, { cycleId, testerRowId, testerSummary, testerData: input.data, matrix });
		} catch (error) {
			console.error("[jev-parallel-check] failed to log result:", error);
		}

		const matrixBlock: TextContent = { type: "text", text: formatMatrixTable(matrix) };
		return { content: [...event.content, matrixBlock] };
	});
}
