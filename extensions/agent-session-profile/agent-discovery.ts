import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveAgentSessionProfile, type AgentRunner, type AgentSessionProfileSource } from "./profile.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  runner?: AgentRunner;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  sessionId?: string;
  sessionProfileSource: AgentSessionProfileSource;
  sessionProfilePath: string;
}

function getAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

function parseFrontmatter<T extends Record<string, string>>(content: string): { frontmatter: T; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {} as T, body: content };
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {} as T, body: content };
  }

  const raw = content.slice(4, end).split("\n");
  const frontmatter = {} as Record<string, string>;
  for (const line of raw) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  return {
    frontmatter: frontmatter as T,
    body: content.slice(end + 5),
  };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((toolName: string) => toolName.trim())
      .filter(Boolean);

    const runner = frontmatter.runner === "claude-cli" ? "claude-cli" : "pi";

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      runner,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope, sessionId?: string): AgentDiscoveryResult {
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
  const resolvedProfile = resolveAgentSessionProfile(cwd, sessionId);
  const sessionProfile = resolvedProfile.profile;

  const agentMap = new Map<string, AgentConfig>();
  if (scope === "both") {
    for (const agent of userAgents) {
      agentMap.set(agent.name, agent);
    }
    for (const agent of projectAgents) {
      agentMap.set(agent.name, agent);
    }
  } else if (scope === "project") {
    for (const agent of projectAgents) {
      agentMap.set(agent.name, agent);
    }
  } else {
    for (const agent of userAgents) {
      agentMap.set(agent.name, agent);
    }
  }

  const agents = Array.from(agentMap.values())
    .map((agent) => {
      const override = sessionProfile?.roles?.[agent.name];
      if (!override) {
        return agent;
      }
      return {
        ...agent,
        runner: override.runner ?? agent.runner,
        model: override.model ?? agent.model,
        thinking: override.thinking ?? agent.thinking,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    agents,
    projectAgentsDir,
    sessionId,
    sessionProfileSource: resolvedProfile.source,
    sessionProfilePath: resolvedProfile.path,
  };
}
