import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Average tokens/sec for the last completed assistant response, shown in the
// footer via setStatus — the same slot agent-session-profile uses, not the
// aboveEditor "something's running" slot subagent-status.ts owns.
export default function (pi: ExtensionAPI) {
  let pendingStart: number | undefined;

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    pendingStart = Date.now();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage || !pendingStart) return;

    const elapsedSeconds = (Date.now() - pendingStart) / 1000;
    pendingStart = undefined;
    if (elapsedSeconds <= 0.05) return; // avoid divide-by-near-zero on trivial/cached replies

    const tokensPerSecond = usage.output / elapsedSeconds;
    ctx.ui.setStatus("tokens-per-second", `${tokensPerSecond.toFixed(1)} tok/s`);
  });
}
