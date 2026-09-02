import * as fs from "node:fs";
import * as path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agent-discovery.ts";
import {
  clearAgentSessionProfile,
  clearGlobalAgentSessionProfile,
  findProjectRoot,
  getAgentSessionProfilePath,
  getGlobalAgentDir,
  hasSessionAgentProfile,
  loadAgentSessionProfile,
  saveAgentSessionProfile,
  type AgentSessionProfile,
  type AgentSessionRoleConfig,
  type ThinkingLevel,
} from "./profile.ts";

const ROLE_ORDER = ["planner", "developer", "tester"] as const;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const CLAUDE_PRESET_MODELS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
] as const;
const CLAUDE_DEFAULT_MODEL = CLAUDE_PRESET_MODELS[0];

type RoleName = (typeof ROLE_ORDER)[number];

function formatAgentLine(role: string, config: AgentSessionRoleConfig | undefined): string {
  if (!config) {
    return `${role}: default`;
  }

  const runner = config.runner || "default";
  const model = config.model || "default";
  const thinking = config.thinking ? ` | thinking:${config.thinking}` : "";
  return `${role}: ${runner} | ${model}${thinking}`;
}

function setProfileWidget(pi: ExtensionAPI, profile: AgentSessionProfile | null): void {
  const runtime = pi as ExtensionAPI & {
    setWidget?: (id: string, lines: string[]) => void;
    setStatus?: (id: string, text: string) => void;
  };

  if (!runtime.setWidget || !runtime.setStatus) {
    return;
  }

  if (!profile) {
    runtime.setWidget("agent-session-profile", ["Agent session profile: default agent config"]);
    runtime.setStatus("agent-session-profile", "agent-profile: default");
    return;
  }

  const lines = ["Agent session profile"];
  for (const role of ROLE_ORDER) {
    lines.push(formatAgentLine(role, profile.roles[role]));
  }
  runtime.setWidget("agent-session-profile", lines);
  runtime.setStatus("agent-session-profile", "agent-profile: configured");
}

function getDefaultRoleConfig(ctx: ExtensionContext, role: RoleName): AgentSessionRoleConfig {
  const discovery = discoverAgents(ctx.cwd, "both", ctx.sessionManager.getSessionId());
  const agent = discovery.agents.find((candidate) => candidate.name === role);
  return {
    runner: agent?.runner,
    model: agent?.model,
    thinking: agent?.thinking as ThinkingLevel | undefined,
  };
}

function parseModelRef(modelRef: string): { provider: string; model: string } | null {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator >= modelRef.length - 1) {
    return null;
  }
  return {
    provider: modelRef.slice(0, separator),
    model: modelRef.slice(separator + 1),
  };
}

async function getAvailableModelRefs(ctx: ExtensionContext): Promise<string[]> {
  const models = (await ctx.modelRegistry.getAvailable()) as Array<Model<Api> & { provider?: string }>;
  const refs = new Set<string>();
  for (const model of models) {
    const provider = model.provider;
    const modelId = model.id;
    if (!provider || !modelId) {
      continue;
    }
    refs.add(`${provider}/${modelId}`);
  }
  return Array.from(refs).sort((left, right) => left.localeCompare(right));
}

function readEnabledModelPatterns(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const enabled = parsed?.enabledModels;
    return Array.isArray(enabled) ? enabled.filter((entry: unknown): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

// Same "enabledModels" patterns pi's own --models / Ctrl+P cycling uses (global settings,
// merged with a project-level settings.json when one exists), so the picker here stays in
// sync with whatever list the user already curated instead of dumping every available model.
function getEnabledModelPatterns(ctx: ExtensionContext): string[] {
  const patterns = new Set(readEnabledModelPatterns(path.join(getGlobalAgentDir(), "settings.json")));

  const projectRoot = findProjectRoot(ctx.cwd);
  if (projectRoot) {
    for (const pattern of readEnabledModelPatterns(path.join(projectRoot, ".pi", "settings.json"))) {
      patterns.add(pattern);
    }
  }

  return Array.from(patterns);
}

async function getScopedModelRefs(ctx: ExtensionContext): Promise<string[]> {
  const patterns = getEnabledModelPatterns(ctx);
  if (patterns.length === 0) {
    return [];
  }
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, ctx.modelRegistry);
  const refs = new Set<string>();
  for (const { model } of scopedModels) {
    refs.add(`${(model as Model<Api> & { provider?: string }).provider}/${model.id}`);
  }
  return Array.from(refs).sort((left, right) => left.localeCompare(right));
}

async function chooseClaudeModel(ctx: ExtensionContext, initialValue: string): Promise<string | null> {
  const selectedModel = initialValue || CLAUDE_DEFAULT_MODEL;
  const options = [
    ...CLAUDE_PRESET_MODELS.map((model) => model === selectedModel ? `${model} (current)` : model),
    "Enter model manually",
  ];
  const choice = await ctx.ui.select("Claude CLI model", options);
  if (!choice) {
    return null;
  }
  if (choice === "Enter model manually") {
    const selected = await ctx.ui.input("Claude CLI model id", selectedModel);
    const trimmed = selected?.trim();
    return trimmed || null;
  }
  return choice.replace(/ \(current\)$/, "");
}

async function resolvePiModelChoice(ctx: ExtensionContext, choice: string, preferred: string | undefined): Promise<string | null> {
  if (choice.startsWith("Use recommended (")) {
    return choice.slice("Use recommended (".length, -1);
  }
  if (choice === "Enter model manually") {
    const typed = await ctx.ui.input("PI model ref (provider/model)", preferred || "openai-codex/gpt-5.4");
    const trimmed = typed?.trim();
    return trimmed || null;
  }
  return choice;
}

async function choosePiModel(ctx: ExtensionContext, preferred: string | undefined): Promise<string | null> {
  const scopedRefs = await getScopedModelRefs(ctx);
  const usingScoped = scopedRefs.length > 0;
  const modelRefs = usingScoped ? scopedRefs : await getAvailableModelRefs(ctx);

  const options = [
    ...(preferred ? [`Use recommended (${preferred})`] : []),
    ...modelRefs,
    ...(usingScoped ? ["Show all models"] : []),
    "Enter model manually",
  ];
  const choice = await ctx.ui.select(usingScoped ? "Select PI model (scoped)" : "Select PI model", options);
  if (!choice) {
    return null;
  }
  if (choice !== "Show all models") {
    return resolvePiModelChoice(ctx, choice, preferred);
  }

  const allRefs = await getAvailableModelRefs(ctx);
  const allChoice = await ctx.ui.select("Select PI model (all available)", [
    ...(preferred ? [`Use recommended (${preferred})`] : []),
    ...allRefs,
    "Enter model manually",
  ]);
  if (!allChoice) {
    return null;
  }
  return resolvePiModelChoice(ctx, allChoice, preferred);
}

async function chooseThinkingLevel(ctx: ExtensionContext, preferred: ThinkingLevel | undefined): Promise<ThinkingLevel | null> {
  const labels = THINKING_LEVELS.map((level) => (level === preferred ? `${level} (current)` : level));
  const choice = await ctx.ui.select("Select thinking level", labels);
  if (!choice) {
    return null;
  }
  return choice.replace(/ \(current\)$/, "") as ThinkingLevel;
}

async function configureRole(
  ctx: ExtensionContext,
  role: RoleName,
  existing: AgentSessionRoleConfig | undefined,
): Promise<AgentSessionRoleConfig | null> {
  const defaults = getDefaultRoleConfig(ctx, role);
  const current = existing || defaults;
  const currentRunner = current.runner || "pi";
  const currentModel = current.model || (currentRunner === "claude-cli" ? CLAUDE_DEFAULT_MODEL : "default");
  const currentThinking = current.thinking;

  const recommendedPiModel = role === "tester"
    ? "openai-codex/gpt-5.6-luna"
    : role === "developer"
      ? "openai-codex/gpt-5.6-luna"
      : defaults.model;
  const recommendedThinking = role === "tester" ? "high" : role === "developer" ? "medium" : defaults.thinking;

  // Only offer "Keep current" when this role already has a real override saved —
  // it's the safe no-op choice so walking through every role in one pass can't
  // accidentally reset one you didn't mean to touch.
  const hasCustomExisting = Boolean(existing && (existing.runner || existing.model || existing.thinking));

  const mode = await ctx.ui.select(`Configure ${role}`, [
    ...(hasCustomExisting
      ? [`Keep current (${currentRunner} | ${currentModel}${currentThinking ? ` | thinking:${currentThinking}` : ""})`]
      : []),
    `Use agent default (${defaults.runner || "pi"} | ${defaults.model || "default"}${defaults.thinking ? ` | thinking:${defaults.thinking}` : ""})`,
    `Claude CLI (${currentRunner === "claude-cli" ? currentModel : CLAUDE_DEFAULT_MODEL})`,
    `PI model (${currentRunner === "pi" ? currentModel : recommendedPiModel || "choose model"}${recommendedThinking ? ` | thinking:${recommendedThinking}` : ""})`,
  ]);

  if (!mode) {
    return null;
  }

  if (mode.startsWith("Keep current")) {
    return { ...existing };
  }

  if (mode.startsWith("Use agent default")) {
    return {};
  }

  if (mode.startsWith("Claude CLI")) {
    const model = await chooseClaudeModel(ctx, currentRunner === "claude-cli" ? currentModel : CLAUDE_DEFAULT_MODEL);
    if (!model) {
      return null;
    }
    return {
      runner: "claude-cli",
      model,
    };
  }

  const model = await choosePiModel(ctx, currentRunner === "pi" ? currentModel : recommendedPiModel);
  if (!model) {
    return null;
  }
  const thinking = await chooseThinkingLevel(ctx, currentThinking || recommendedThinking || "medium");
  if (!thinking) {
    return null;
  }
  return {
    runner: "pi",
    model,
    thinking,
  };
}

async function configureProfile(ctx: ExtensionContext): Promise<AgentSessionProfile | null> {
  const sessionId = ctx.sessionManager.getSessionId();
  const existing = loadAgentSessionProfile(ctx.cwd, sessionId);
  const roles: Record<string, AgentSessionRoleConfig> = {};

  for (const role of ROLE_ORDER) {
    const configured = await configureRole(ctx, role, existing?.roles[role]);
    if (!configured) {
      return null;
    }
    roles[role] = configured;
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    roles,
  };
}

async function applyProfileIfPossible(pi: ExtensionAPI, _ctx: ExtensionContext, profile: AgentSessionProfile | null): Promise<void> {
  if (!profile) {
    setProfileWidget(pi, null);
    return;
  }

  setProfileWidget(pi, profile);
}

async function handleProfileSetup(pi: ExtensionAPI, ctx: ExtensionContext, forceInteractive: boolean): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const existing = loadAgentSessionProfile(ctx.cwd, sessionId);
  const sessionProfileExists = hasSessionAgentProfile(sessionId);

  if (!forceInteractive) {
    // Session start: adopt whatever resolves (session/project/global) silently.
    // Only prompt when nothing resolves anywhere and no explicit clear is on record.
    if (existing) {
      await applyProfileIfPossible(pi, ctx, existing);
      return;
    }

    if (sessionProfileExists) {
      setProfileWidget(pi, null);
      return;
    }

    const shouldConfigure = await ctx.ui.confirm(
      "Agent session profile",
      "Configure planner / developer / tester for this session?",
    );
    if (!shouldConfigure) {
      setProfileWidget(pi, null);
      return;
    }

    const profile = await configureProfile(ctx);
    if (!profile) {
      ctx.ui.notify("Agent profile setup cancelled", "info");
      setProfileWidget(pi, null);
      return;
    }

    const profilePath = saveAgentSessionProfile(ctx.cwd, sessionId, profile);
    await applyProfileIfPossible(pi, ctx, profile);
    ctx.ui.notify(`Agent session profile saved: ${profilePath}`, "info");
    return;
  }

  // Explicit /agent-profile invocation: offer to use/edit/clear an existing profile,
  // or go straight into setup when nothing is configured yet.
  if (!existing) {
    const profile = await configureProfile(ctx);
    if (!profile) {
      ctx.ui.notify("Agent profile setup cancelled", "info");
      return;
    }
    const profilePath = saveAgentSessionProfile(ctx.cwd, sessionId, profile);
    await applyProfileIfPossible(pi, ctx, profile);
    ctx.ui.notify(`Agent session profile saved: ${profilePath}`, "info");
    return;
  }

  const choice = await ctx.ui.select("Agent session profile", [
    "Use saved profile",
    "Edit saved profile",
    "Clear profile",
  ]);
  if (!choice) {
    await applyProfileIfPossible(pi, ctx, existing);
    return;
  }
  if (choice === "Use saved profile") {
    await applyProfileIfPossible(pi, ctx, existing);
    return;
  }
  if (choice === "Clear profile") {
    const clearedPath = clearAgentSessionProfile(ctx.cwd, sessionId);
    setProfileWidget(pi, null);
    ctx.ui.notify(`Cleared agent session profile: ${clearedPath}`, "info");
    return;
  }

  const profile = await configureProfile(ctx);
  if (!profile) {
    ctx.ui.notify("Agent profile setup cancelled", "info");
    await applyProfileIfPossible(pi, ctx, existing);
    return;
  }
  const profilePath = saveAgentSessionProfile(ctx.cwd, sessionId, profile);
  await applyProfileIfPossible(pi, ctx, profile);
  ctx.ui.notify(`Agent session profile saved: ${profilePath}`, "info");
}

export default function agentSessionProfileExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // /reload reopens the profile picker (use/edit/clear); every other
    // session_start reason (startup, new, resume, fork) stays silent.
    // Either way, saves only ever touch this session's own profile file —
    // no write-through to project/global, so this is confined to this session.
    await handleProfileSetup(pi, ctx, event.reason === "reload");
  });

  pi.registerCommand("agent-profile", {
    description: "Configure per-role session models/runners for planner, developer, and tester",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const trimmed = args.trim().toLowerCase();
      if (trimmed === "show") {
        const profile = loadAgentSessionProfile(ctx.cwd, sessionId);
        const profilePath = getAgentSessionProfilePath(ctx.cwd, sessionId);
        if (!profile) {
          ctx.ui.notify(`No saved agent session profile at ${profilePath}`, "info");
          return;
        }
        setProfileWidget(pi, profile);
        ctx.ui.notify(`Showing saved agent session profile: ${profilePath}`, "info");
        return;
      }

      if (trimmed === "clear" || trimmed === "reset") {
        const clearedPath = clearAgentSessionProfile(ctx.cwd, sessionId);
        setProfileWidget(pi, null);
        ctx.ui.notify(`Cleared agent session profile: ${clearedPath}`, "info");
        return;
      }

      if (trimmed === "clear-global" || trimmed === "reset-global") {
        const clearedPath = clearGlobalAgentSessionProfile();
        const resolved = loadAgentSessionProfile(ctx.cwd, sessionId);
        setProfileWidget(pi, resolved);
        ctx.ui.notify(`Cleared global agent session profile: ${clearedPath}`, "info");
        return;
      }

      await handleProfileSetup(pi, ctx, true);
    },
  });
}
