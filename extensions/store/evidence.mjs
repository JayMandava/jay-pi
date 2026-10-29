import { verifyCycleEvidence } from '../cycle-store.mjs';

// Narration is not evidence: a run counts as having recorded its stage only
// if a successful record_cycle tool result for that stage carries a receipt
// that the persisted row confirms (same run, same stage, same role).
export const isRecordTool = (name) => name === 'record_cycle' || name === 'mcp__record-cycle__record_cycle';

export function receiptOf(message) {
  if (message.details?.ok === true) return message.details;
  for (const part of message.content || []) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      try {
        const value = JSON.parse(part.text);
        if (value?.ok === true) return value;
      } catch { /* not a JSON receipt */ }
    }
  }
  return null;
}

export function hasVerifiedCycleRecord(cwd, messages, stage, runId, cycleId) {
  const calls = new Map();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === 'toolCall' && isRecordTool(p.name) && typeof p.id === 'string') calls.set(p.id, p.arguments?.stage);
      }
    }
    if (msg.role === 'toolResult' && !msg.isError && isRecordTool(msg.toolName) && calls.get(msg.toolCallId) === stage) {
      const receipt = receiptOf(msg);
      if (receipt?.stage === stage && receipt.runId === runId && verifyCycleEvidence(cwd, stage, receipt.rowId, { runId, cycleId })) return true;
    }
  }
  return false;
}
