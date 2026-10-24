import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentRunner = "pi" | "claude-cli" | "codex-cli";
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch {
    throw new Error(`Cannot read agent profile: ${profilePath}. Repair or remove it before running agents.`);
  }
  if (parsed === null) return null;
  const profile = parsed as AgentSessionProfile;
  if (!profile || profile.version !== 1 || !profile.roles || typeof profile.roles !== "object" || Array.isArray(profile.roles)) {
    throw new Error(`Invalid agent profile: ${profilePath}. Expected version 1 and a roles object.`);
  }
  const runners = ["pi", "claude-cli", "codex-cli"];
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  for (const role of Object.values(profile.roles)) {
    if (!role || typeof role !== "object" || Array.isArray(role)
      || (role.runner !== undefined && !runners.includes(role.runner))
      || (role.model !== undefined && (typeof role.model !== "string" || !role.model.trim()))
      || (role.thinking !== undefined && !thinkingLevels.includes(role.thinking))) {
      throw new Error(`Invalid role configuration in agent profile: ${profilePath}.`);
    }
  }
  return profile;
}

/**
 * Merge fields, not entire role maps: session > project > global. Source/path
 * identify the highest participating layer, while profile contains the merge.
 * An explicit session JSON null is the existing "clear this session" tombstone:
 * it suppresses all inherited overrides. A null project/global file contributes
 * no values. Malformed files are errors, never a silent fallback to another runner.
 */
export function resolveAgentSessionProfile(cwd: string, sessionId?: string): ResolvedAgentSessionProfile {
  const globalPath = getGlobalAgentSessionProfilePath();
  const projectPath = getProjectAgentSessionProfilePath(cwd);
  const sessionPath = sessionId ? getSessionAgentSessionProfilePath(sessionId) : null;
  // A session clear must work even if a lower layer needs repair.
  const sessionExists = !!sessionPath && fs.existsSync(sessionPath);
  const sessionProfile = sessionExists ? readProfileAtPath(sessionPath!) : undefined;
  if (sessionExists && sessionProfile === null) {
    return { profile: null, source: "session", path: sessionPath!, sessionId };
  }
  const layers: Array<{ source: AgentSessionProfileSource; path: string; profile: AgentSessionProfile | null }> = [];
  for (const [source, layerPath] of [["global", globalPath], ["project", projectPath]] as const) {
    if (layerPath && fs.existsSync(layerPath)) {
      layers.push({ source, path: layerPath, profile: readProfileAtPath(layerPath) });
    }
  }
  if (sessionExists) layers.push({ source: "session", path: sessionPath!, profile: sessionProfile! });
  let resolved: ResolvedAgentSessionProfile = {
    profile: null, source: "none", path: sessionPath || projectPath || globalPath, sessionId,
  };
  for (const layer of layers) {
    if (!layer.profile) continue;
    const roles = { ...resolved.profile?.roles };
    for (const [name, role] of Object.entries(layer.profile.roles)) {
      Object.defineProperty(roles, name, {
        value: { ...roles[name], ...role }, enumerable: true, writable: true, configurable: true,
      });
    }
    resolved = { ...resolved, source: layer.source, path: layer.path, profile: { ...layer.profile, roles } };
  }
  return resolved;
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
