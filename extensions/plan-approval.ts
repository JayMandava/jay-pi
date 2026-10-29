import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getLatestApproach, approveApproach, isApproachApproved } from './store/approval-store.mjs';

export function getLatestApproachRowId(cwd: string): number | null {
  try { return getLatestApproach(cwd)?.id ?? null; } catch { return null; }
}
export const isApproachRowApproved = isApproachApproved;

const ApprovePlanParams = Type.Object({
  approachRowId: Type.Optional(Type.Integer({ minimum: 1, description: 'The latest approach.db row to review and approve.' })),
});

export default function planApproval(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'approve_plan',
    label: 'Approve plan',
    description: 'Record the human\'s approval of the latest plan, after a real Grilling Discipline review. Approval is bound to the row and its content digest, so a revised plan needs a fresh approval; background agents cannot self-approve.',
    parameters: ApprovePlanParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const fail = (text: string) => ({ details: undefined, content: [{ type: 'text' as const, text }], isError: true });
      if (signal?.aborted) return fail('Plan approval canceled before review. Developer remains blocked.');
      if (!ctx.hasUI) return fail('approve_plan requires an interactive session — a background subagent cannot self-approve a plan.');
      try {
        const plan = getLatestApproach(ctx.cwd);
        if (!plan) return fail('No approach.db row found to approve — Planner has not recorded a plan yet.');
        if (params.approachRowId !== undefined && params.approachRowId !== plan.id) return fail('Only the latest existing plan may be approved. Review the latest plan first.');
        // The human review already happened in the Lead's grill session; this call only records it.
        // Binding to the row's content digest means a plan revised afterwards is not covered.
        const result = approveApproach(ctx.cwd, plan.id, { confirmed: true, actor: 'interactive-human', expectedDigest: plan.digest });
        return { content: [{ type: 'text' as const, text: `Approved approach.db row ${plan.id} at ${result.approvedAt}. Developer can now execute this plan.` }], details: result };
      } catch (error) { return fail(`Plan approval failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  });
}
