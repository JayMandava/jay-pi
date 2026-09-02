import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_MD_PATH = path.join(os.homedir(), "AGENTS.md");
const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "agents-md-freshness", "sessions");

interface FreshnessRecord {
	hash: string;
	notedAt: string;
}

function hashFile(filePath: string): string | undefined {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8")).digest("hex");
	} catch {
		return undefined;
	}
}

function readRecord(sessionId: string): FreshnessRecord | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sessionId}.json`), "utf8"));
	} catch {
		return null;
	}
}

function writeRecord(sessionId: string, record: FreshnessRecord): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(path.join(STATE_DIR, `${sessionId}.json`), JSON.stringify(record, null, 2));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;

		const currentHash = hashFile(AGENTS_MD_PATH);
		if (!currentHash) return; // no AGENTS.md to track

		const record = readRecord(sessionId);
		if (!record) {
			// No freshness record for this session yet. A genuinely "new" session
			// just read the current file, so it's fresh by construction — silently
			// baseline it. Every other reason (resume, fork, reload, startup)
			// means this session's context may predate this tracker entirely,
			// which is exactly the unknown-freshness case that caused the Patties
			// gap (a month-old resumed session silently operating on a stale
			// AGENTS.md contract) — warn instead of assuming it's fine.
			if (event.reason !== "new") {
				ctx.ui.notify(
					"AGENTS.md freshness is untracked for this session (it predates this check) — the lead's operating contract may be stale. Consider asking it to re-read AGENTS.md in full, or start a fresh session.",
					"warning",
				);
			}
			writeRecord(sessionId, { hash: currentHash, notedAt: new Date().toISOString() });
			return;
		}

		if (record.hash !== currentHash) {
			ctx.ui.notify(
				`AGENTS.md has changed since this session last saw it (${record.notedAt}) — the lead may be operating on a stale contract. Ask it to re-read AGENTS.md in full, or start a fresh session.`,
				"warning",
			);
			writeRecord(sessionId, { hash: currentHash, notedAt: new Date().toISOString() });
		}
	});
}
