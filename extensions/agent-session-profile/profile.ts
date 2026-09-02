import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentRunner = "pi" | "claude-cli";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentSessionRoleConfig {
  runner?: AgentRunner;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface AgentSessionProfile {
  version: 1;
  updatedAt: string;
  roles: Record<string, AgentSessionRoleConfig>;
}

export type AgentSessionProfileSource = "session" | "project" | "global" | "none";

export interface ResolvedAgentSessionProfile {
  profile: AgentSessionProfile | null;
  source: AgentSessionProfileSource;
  path: string;
  sessionId?: string;
}

function getSessionProfileDir(): string {
  return path.join(getGlobalAgentDir(), "extensions", "agent-session-profile");
}

function getSessionProfileStateDir(): string {
  return path.join(getSessionProfileDir(), "sessions");
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function looksLikeProjectPiDir(projectPiDir: string): boolean {
  return isDirectory(path.join(projectPiDir, "agents"))
    || isDirectory(path.join(projectPiDir, "extensions"))
    || isFile(path.join(projectPiDir, "settings.json"));
}

export function findProjectRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidatePiDir = path.join(currentDir, ".pi");
    if (looksLikeProjectPiDir(candidatePiDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function getGlobalAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

export function getGlobalAgentSessionProfilePath(): string {
  return path.join(getGlobalAgentDir(), "agent-session-profile.json");
}

export function getProjectAgentSessionProfilePath(cwd: string): string | null {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    return null;
  }
  return path.join(projectRoot, "data", "agent-session-profile.json");
}

export function getSessionAgentSessionProfilePath(sessionId: string): string {
  return path.join(getSessionProfileStateDir(), `${sessionId}.json`);
}

function readProfileAtPath(profilePath: string): AgentSessionProfile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as AgentSessionProfile | null;
    if (parsed === null) {
      return null;
    }
    if (!parsed || parsed.version !== 1 || !parsed.roles || typeof parsed.roles !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function resolveAgentSessionProfile(cwd: string, sessionId?: string): ResolvedAgentSessionProfile {
  if (sessionId) {
    const sessionPath = getSessionAgentSessionProfilePath(sessionId);
    if (fs.existsSync(sessionPath)) {
      return {
        profile: readProfileAtPath(sessionPath),
        source: "session",
        path: sessionPath,
        sessionId,
      };
    }
  }

  const projectPath = getProjectAgentSessionProfilePath(cwd);
  if (projectPath && fs.existsSync(projectPath)) {
    const profile = readProfileAtPath(projectPath);
    if (profile) {
      return {
        profile,
        source: "project",
        path: projectPath,
        sessionId,
      };
    }
  }

  const globalPath = getGlobalAgentSessionProfilePath();
  if (fs.existsSync(globalPath)) {
    const profile = readProfileAtPath(globalPath);
    if (profile) {
      return {
        profile,
        source: "global",
        path: globalPath,
        sessionId,
      };
    }
  }

  return {
    profile: null,
    source: "none",
    path: sessionId
      ? getSessionAgentSessionProfilePath(sessionId)
      : (projectPath || globalPath),
    sessionId,
  };
}

export function getAgentSessionProfilePath(cwd: string, sessionId?: string): string {
  return resolveAgentSessionProfile(cwd, sessionId).path;
}

export function hasSessionAgentProfile(sessionId: string): boolean {
  return fs.existsSync(getSessionAgentSessionProfilePath(sessionId));
}

export function loadAgentSessionProfile(cwd: string, sessionId?: string): AgentSessionProfile | null {
  return resolveAgentSessionProfile(cwd, sessionId).profile;
}

export function saveAgentSessionProfile(_cwd: string, sessionId: string, profile: AgentSessionProfile): string {
  const targetPath = getSessionAgentSessionProfilePath(sessionId);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return targetPath;
}

export function clearAgentSessionProfile(_cwd: string, sessionId: string): string {
  const targetPath = getSessionAgentSessionProfilePath(sessionId);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "null\n", "utf8");
  return targetPath;
}

export function clearGlobalAgentSessionProfile(): string {
  const globalPath = getGlobalAgentSessionProfilePath();
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(globalPath, "null\n", "utf8");
  return globalPath;
}
