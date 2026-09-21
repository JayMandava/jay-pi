import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appendHistoryEvent } from "./cycle-store.mjs";

// Code-enforces the "Grilling Discipline" pattern already described in
// AGENTS.md (one question at a time, a recommended default attached, no
// bundling) instead of leaving it as a prose convention Lead can silently
// drift from. Two things this buys:
//
// 1. `recommended` is a required field — TypeBox rejects a call missing it
//    before this tool's own code ever runs, the same way record_cycle's
//    schema makes `summary` mandatory rather than trusting the model to
//    remember to include one.
// 2. "One question at a time" is true by construction, not by convention:
//    this tool blocks on ctx.ui.select and returns the human's actual
//    answer as the tool result, so there is no way for a second question to
//    be in flight before the first one resolves. The gap this closes is
//    Lead bundling several questions into a single prose chat message
//    instead of going through a tool call at all — AGENTS.md now says every
//    grilling-gate question goes through this tool, not freehand chat.
const GrillParams = Type.Object({
	question: Type.String({ description: "The single question to ask — one at a time, no bundling." }),
	options: Type.Array(Type.String(), { minItems: 2, description: "The choices to present, including the recommended one." }),
	recommended: Type.String({ description: "Which of `options` you recommend — must be one of them. Required, not optional." }),
	context: Type.Optional(Type.String({ description: "One or two sentences of context shown above the question, if useful." })),
});

export default function grill(pi: ExtensionAPI) {
	pi.registerTool({
		name: "grill",
		label: "Grill",
		description:
			"Ask the human exactly one question, with a required recommended default, as part of a Grilling Discipline review gate (POA review, Developer output review, Tester findings review, PR review, external-sink preview). Use this instead of asking in freeform chat text so the question/default/answer is unambiguous and durably logged. Requires an interactive session — never call this from a background subagent.",
		parameters: GrillParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "grill requires an interactive session with UI — this cannot run from a background subagent." }],
					isError: true,
				};
			}
			if (!params.options.includes(params.recommended)) {
				return {
					content: [{ type: "text", text: `recommended ("${params.recommended}") must be one of options: ${params.options.join(", ")}.` }],
					isError: true,
				};
			}

			const labeled = params.options.map((option) => (option === params.recommended ? `${option} (recommended)` : option));
			const title = params.context ? `${params.context}\n\n${params.question}` : params.question;
			const answer = await ctx.ui.select(title, labeled);
			const resolvedAnswer = answer?.replace(/ \(recommended\)$/, "") ?? null;

			appendHistoryEvent(ctx.cwd, {
				event: "grill",
				question: params.question,
				options: params.options,
				recommended: params.recommended,
				answer: resolvedAnswer,
			});

			if (resolvedAnswer === null) {
				return { content: [{ type: "text", text: "Human dismissed the question without answering." }], isError: true };
			}
			return { content: [{ type: "text", text: `Human answered: ${resolvedAnswer}` }], details: { question: params.question, answer: resolvedAnswer } };
		},
	});
}
