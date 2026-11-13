// Adapted from @luan.sh/pi-collapse-transcript 0.3.6 test/transcript.test.ts.
// MIT (c) 2026 Luan Santos; see ../../extensions/collapse-transcript/LICENSE.
// Assertions run inside the installed Pi to use its actual native components.
import assert from "node:assert/strict";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const cases: { name: string; run: () => void | Promise<void> }[] = [];
function test(name: string, run: () => void | Promise<void>): void { cases.push({ name, run }); }
let theme: Theme;
const cleanups: (() => void)[] = [];

import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	initTheme,
	type SessionEntry,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, Text, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, sharedMotionScheduler, tuiTheme } from "@luan.sh/pi-libtui";
import type { TuiMouseEvent } from "@luan.sh/pi-libtui/mouse";
import { ensureMouseRegistry, getMouseRegistryState } from "../../node_modules/@luan.sh/pi-libtui/src/mouse/registry.ts";
import { mountTranscriptProjection, ToolActivity, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";
import { ActivityTimings } from "../../extensions/collapse-transcript/activity-timing.ts";
import { ActivityTranscript, activitySummary } from "../../extensions/collapse-transcript/activity-transcript.ts";


class TestTui extends TuiAltScreen {
	requestRender(): void {}
}
class TestMainTui extends TuiMainScreen {
	requestRender(): void {}
}

function message(content: Parameters<AssistantMessageComponent["updateContent"]>[0]["content"]) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 0,
	};
}

function fixture(timings = new ActivityTimings(), now: () => number = () => 0, activeTheme = theme, mode: "regular" | "fullscreen" = "fullscreen") {
	configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
	const tui = mode === "regular" ? new TestMainTui(new ProcessTerminal()) : new TestTui(new ProcessTerminal());
	const document = new Container();
	const chat = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	tui.addChild(document);
	let projection: ActivityTranscript | undefined;
	const unmount = mountTranscriptProjection(tui, (entries) => {
		projection = new ActivityTranscript(entries, activeTheme, () => {}, timings, now, tui);
		return projection;
	});
	if (!unmount || !projection) throw new Error("Expected a mounted transcript");
	cleanups.push(unmount);
	return { tui, document, chat, projection, unmount };
}

function lines(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}
function click(projection: ActivityTranscript, row: number): void {
	const event: TuiMouseEvent = {
		type: "press",
		row,
		col: 2,
		screenRow: row,
		screenCol: 2,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	assert.equal(projection.onMouse(event), true);
	assert.equal(projection.onMouse({ ...event, type: "release" }), true);
}

test("literal closing tags inside inline code do not expose the remaining thinking", () => {
	for (const literal of [
		"`<thinking>...</thinking>`",
		"``a ` </thinking> ` b``",
		"``a ``` </thinking> ``` b``",
		"`first line\n</thinking>\nlast line`",
		"\\</thinking>",
	]) {
		const f = fixture();
		const source = message([{ type: "text", text: [
			"<thinking>**Quoted tag summary**", "",
			"Discuss the literal " + literal + " marker.", "",
			"HIDDEN_QUOTED_TAIL", "</thinking>", "", "VISIBLE_QUOTED_ANSWER",
		].join("\n") }]);
		const saved = JSON.stringify(source);
		f.chat.addChild(new AssistantMessageComponent(source));
		const compact = lines(f.document, 120);
		assert.doesNotMatch(compact.join("\n"), /HIDDEN_QUOTED_TAIL|<\/?thinking>/, literal);
		assert.match(compact.join("\n"), /VISIBLE_QUOTED_ANSWER/);
		click(f.projection, compact.findIndex((line) => line.includes("Worked")));
		const expanded = lines(f.document, 120).join("\n");
		assert.equal(expanded.split("HIDDEN_QUOTED_TAIL").length - 1, 1);
		assert.match(expanded, /VISIBLE_QUOTED_ANSWER/);
		assert.equal(JSON.stringify(source), saved);
	}
});

test("an unfinished streamed code span cannot prematurely close the thinking fold", () => {
	const f = fixture();
	const native = new AssistantMessageComponent();
	const prefix = "<thinking>**Streaming quoted tag**\n\nLiteral ";
	const quoted = "`</thinking>";
	const suffix = "` stays quoted.\n\nHIDDEN_STREAM_TAIL\n</thinking>\n\nVISIBLE_STREAM_ANSWER";
	native.updateContent(message([{ type: "text", text: prefix }]), true);
	f.chat.addChild(native);
	// Live thinking starts open; fold it to inspect the boundary while tokens arrive.
	click(f.projection, lines(f.document).findIndex((line) => line.includes("Working")));
	for (let end = 0; end <= quoted.length; end++) {
		native.updateContent(message([{ type: "text", text: prefix + quoted.slice(0, end) }]), true);
		assert.doesNotMatch(lines(f.document).join("\n"), /<\/?thinking>|Literal/);
	}
	native.updateContent(message([{ type: "text", text: prefix + quoted + suffix }]), true);
	const compact = lines(f.document);
	assert.doesNotMatch(compact.join("\n"), /HIDDEN_STREAM_TAIL|<\/?thinking>/);
	assert.match(compact.join("\n"), /VISIBLE_STREAM_ANSWER/);
	click(f.projection, compact.findIndex((line) => line.includes("Working")));
	native.updateContent(message([{ type: "text", text: prefix + quoted + suffix }]), false);
	f.projection.invalidate();
	assert.match(lines(f.document, 100).join("\n"), /HIDDEN_STREAM_TAIL/);
	assert.match(lines(f.document, 100).join("\n"), /VISIBLE_STREAM_ANSWER/);
});


test("unmatched or escaped backticks do not hide a finished answer", () => {
	for (const body of ["An unmatched ` marker.", "An escaped \\` marker."]) {
		const f = fixture();
		f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text:
			"<thinking>**Literal backtick**\n\n" + body + "\nHIDDEN_BACKTICK_TAIL</thinking> VISIBLE_BACKTICK_ANSWER",
		}])));
		const rendered = lines(f.document).join("\n");
		assert.doesNotMatch(rendered, /HIDDEN_BACKTICK_TAIL/);
		assert.match(rendered, /VISIBLE_BACKTICK_ANSWER/);
	}
});

test("an unmatched backtick before a workflow fence does not mask the workflow", () => {
	const f = fixture();
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: [
		"An unmatched ` marker.",
		"```js workflow", "return 'WORKFLOW_AFTER_BACKTICK';", "```",
		"Unrelated ` after the block.",
	].join("\n") }])));
	const compact = lines(f.document);
	assert.match(compact.join("\n"), /Workflow source/);
	assert.doesNotMatch(compact.join("\n"), /WORKFLOW_AFTER_BACKTICK/);
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	assert.match(lines(f.document).join("\n"), /WORKFLOW_AFTER_BACKTICK/);
});

test("multiline inline-code examples keep literal thinking tags visible", () => {
	const f = fixture();
	const native = new AssistantMessageComponent(message([{ type: "text", text:
		"Example: `\n<thinking>VISIBLE_CODE_EXAMPLE</thinking>\n`.",
	}]));
	const original = lines(native);
	f.chat.addChild(native);
	assert.deepEqual(lines(f.document), original);
});

test("tagged thinking joins native thinking and tools without rewriting history", () => {
	const f = fixture();
	const source = message([{ type: "text", text: "<thinking>**Tagged summary**\n\nTAGGED_DETAIL\n</thinking>" }]);
	const saved = JSON.stringify(source);
	f.chat.addChild(new AssistantMessageComponent(source));
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Native summary**\n\nNATIVE_DETAIL" }])));
	const tool = new ToolExecutionComponent("read", "tagged", {}, undefined, undefined, f.tui, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: "TAGGED_TOOL_RESULT" }], isError: false });
	f.chat.addChild(tool);
	const compact = lines(f.document);
	assert.doesNotMatch(compact.join("\n"), /TAGGED_DETAIL|NATIVE_DETAIL|TAGGED_TOOL_RESULT|<\/?thinking>/);
	assert.equal(compact.filter((line) => line.includes("Worked")).length, 1);
	assert.match(compact.join("\n"), /3 steps/);
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	const expanded = lines(f.document).join("\n");
	for (const marker of ["TAGGED_DETAIL", "NATIVE_DETAIL", "TAGGED_TOOL_RESULT"])
		assert.equal(expanded.split(marker).length - 1, 1);
	assert.equal(JSON.stringify(source), saved);
	f.unmount();
	assert.match(lines(f.document).join("\n"), /<thinking>/);
});

test("tagged thinking preserves surrounding prose and whole-message transforms", () => {
	const f = fixture();
	const source = message([{ type: "text", text: "Before.\n\n<thinking>**Brief summary**\n\nTAGGED_DETAIL\n</thinking>\n\nAfter." }]);
	const native = new AssistantMessageComponent(source, false, undefined, undefined, 3, [
		(markdown) => markdown + "\n\nONE_FOOTER",
	]);
	f.chat.addChild(native);
	const compact = lines(f.document);
	assert.match(compact.join("\n"), /Before\./);
	assert.match(compact.join("\n"), /After\./);
	assert.doesNotMatch(compact.join("\n"), /TAGGED_DETAIL|<\/?thinking>/);
	assert.equal(compact.join("\n").split("ONE_FOOTER").length - 1, 1);
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	assert.equal(lines(f.document).join("\n").split("ONE_FOOTER").length - 1, 1);
	assert.match(lines(f.document).join("\n"), /TAGGED_DETAIL/);
});

test("tagged thinking streams open and folds once its answer follows", () => {
	const f = fixture();
	const initial = "<thinking>**Live summary**\n\nSTREAM_THOUGHT";
	const source = message([{ type: "text", text: initial }]);
	const native = new AssistantMessageComponent();
	native.updateContent(source, true);
	f.chat.addChild(native);
	const live = lines(f.document).join("\n");
	assert.match(live, /Working.*Live summary/);
	assert.match(live, /STREAM_THOUGHT/);
	source.content = [{ type: "text", text: initial + "\nMORE_THOUGHT\n</thinking>\n\nVisible answer." }];
	native.updateContent(source, false);
	const complete = lines(f.document);
	assert.doesNotMatch(complete.join("\n"), /STREAM_THOUGHT|MORE_THOUGHT|Working/);
	assert.match(complete.join("\n"), /Visible answer/);
	click(f.projection, complete.findIndex((line) => line.includes("Worked")));
	const expanded = lines(f.document).join("\n");
	assert.match(expanded, /STREAM_THOUGHT/);
	assert.match(expanded, /MORE_THOUGHT/);
});


test("thinking examples, incomplete final tags and regular scrollback stay visible", () => {
	for (const text of [
		"```xml\n<thinking>EXAMPLE_DETAIL</thinking>\n```",
		"````markdown\n<thinking>EXAMPLE_DETAIL</thinking>\n````",
		"Example:\n\n  ```xml\n<thinking>EXAMPLE_DETAIL</thinking>\n  ```",
		"    <thinking>EXAMPLE_DETAIL</thinking>",
		"> <thinking>EXAMPLE_DETAIL</thinking>",
		"Explain `<thinking>EXAMPLE_DETAIL</thinking>`.",
		"<thinking>EXAMPLE_DETAIL",
	]) {
		const f = fixture();
		const native = new AssistantMessageComponent(message([{ type: "text", text }]));
		const original = lines(native);
		f.chat.addChild(native);
		assert.deepEqual(lines(f.document), original);
	}
	const regular = fixture(undefined, undefined, undefined, "regular");
	regular.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "<thinking>REGULAR_THOUGHT</thinking>" }])));
	assert.match(lines(regular.document).join("\n"), /<thinking>REGULAR_THOUGHT<\/thinking>/);
	assert.doesNotMatch(lines(regular.document).join("\n"), /Worked|Working/);
});

test("interrupted native thinking folds while partial answers and native notices remain visible", () => {
	for (const stopReason of ["error", "aborted", "length"] as const) {
		const f = fixture();
		const source = {
			...message([
				{ type: "thinking" as const, thinking: "**Interrupted summary**\n\nINTERRUPTED_DETAIL" },
				{ type: "text" as const, text: "Partial answer." },
			]),
			stopReason, errorMessage: "STREAM_FAILED",
		};
		const saved = JSON.stringify(source);
		f.chat.addChild(new AssistantMessageComponent(source));
		const compact = lines(f.document);
		assert.doesNotMatch(compact.join("\n"), /INTERRUPTED_DETAIL/);
		assert.match(compact.join("\n"), /Partial answer/);
		const notice = stopReason === "length" ? "Response was truncated before completion." : "STREAM_FAILED";
		assert.equal(compact.join("\n").split(notice).length - 1, 1);
		click(f.projection, compact.findIndex((line) => line.includes("Worked")));
		const expanded = lines(f.document).join("\n");
		assert.match(expanded, /INTERRUPTED_DETAIL/);
		assert.equal(expanded.split(notice).length - 1, 1);
		assert.equal(JSON.stringify(source), saved);
		f.unmount();
		assert.match(lines(f.document).join("\n"), /INTERRUPTED_DETAIL/);
	}
});

test("tagged thinking handles same-line closers and keeps fenced tags inside the thought", () => {
	const f = fixture();
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: [
		"<thinking>**First thought**\n\nFIRST_DETAIL</thinking> Visible answer.",
		"",
		"<thinking>**Second thought**\n\nSECOND_DETAIL",
		"```xml", "</thinking>", "```",
		"STILL_INSIDE", "</thinking>", "", "Last answer.",
	].join("\n") }])));
	const compact = lines(f.document);
	assert.doesNotMatch(compact.join("\n"), /FIRST_DETAIL|SECOND_DETAIL|STILL_INSIDE|<\/?thinking>/);
	assert.match(compact.join("\n"), /Visible answer/);
	assert.match(compact.join("\n"), /Last answer/);
	click(f.projection, compact.findIndex((line) => line.includes("Second thought")));
	assert.match(lines(f.document).join("\n"), /SECOND_DETAIL/);
	assert.match(lines(f.document).join("\n"), /STILL_INSIDE/);
});

test("interrupted views retain disclosure on updates and preserve native tool-call notices", () => {
	for (const stopReason of ["error", "aborted", "length"] as const) {
		const f = fixture();
		const source = {
			...message([
				{ type: "thinking" as const, thinking: "**Interrupted**\n\nBEFORE_UPDATE" },
				{ type: "toolCall" as const, id: "partial-call", name: "read", arguments: {} },
			]),
			stopReason, errorMessage: "NATIVE_TOOL_NOTICE",
		};
		const native = new AssistantMessageComponent(source);
		const original = lines(native).join("\n");
		f.chat.addChild(native);
		const compact = lines(f.document);
		assert.doesNotMatch(compact.join("\n"), /BEFORE_UPDATE/);
		for (const notice of ["NATIVE_TOOL_NOTICE", "Response was truncated"])
			assert.equal(compact.join("\n").includes(notice), original.includes(notice));
		click(f.projection, compact.findIndex((line) => line.includes("Worked")));
		source.content[0] = { type: "thinking", thinking: "**Interrupted**\n\nAFTER_UPDATE" };
		native.updateContent(source);
		f.projection.invalidate();
		assert.match(lines(f.document, 60).join("\n"), /AFTER_UPDATE/);
		assert.doesNotMatch(lines(f.document, 60).join("\n"), /BEFORE_UPDATE/);
	}
	const regular = fixture(undefined, undefined, undefined, "regular");
	const native = new AssistantMessageComponent({
		...message([{ type: "thinking", thinking: "REGULAR_INTERRUPTED" }]),
		stopReason: "error", errorMessage: "REGULAR_ERROR",
	});
	const original = lines(native);
	regular.chat.addChild(native);
	assert.deepEqual(lines(regular.document), original);
});

test("reused workflow messages and streaming-only transitions retain current output", () => {
	const f = fixture();
	const source = message([{ type: "text", text: "```js workflow\nreturn 'REUSED_ONE';\n```" }]);
	const native = new AssistantMessageComponent(source, false, undefined, undefined, 1, [
		(markdown, context) => markdown + "\n\nSTREAM_CONTEXT_" + context.isStreaming,
	]);
	native.updateContent(source, true);
	f.chat.addChild(native);
	assert.match(lines(f.document).join("\n"), /REUSED_ONE/);
	source.content = [{ type: "text", text: "```js workflow\nreturn 'REUSED_TWO';\n```" }];
	native.updateContent(source, true);
	assert.match(lines(f.document).join("\n"), /REUSED_TWO/);
	native.updateContent(source, false);
	click(f.projection, lines(f.document).findIndex((line) => line.includes("Worked")));
	const done = lines(f.document).join("\n");
	assert.match(done, /REUSED_TWO/);
	assert.match(done, /STREAM_CONTEXT_false/);
	assert.doesNotMatch(done, /Working|STREAM_CONTEXT_true|REUSED_ONE/);
});


for (const language of ["js", "javascript"]) {
	test(`${language} workflow source folds with its tool and expands once without editing history`, () => {
		const f = fixture();
		const source = message([
			{ type: "text", text: ["```" + language + " workflow", 'return "WORKFLOW_SOURCE";', "```"].join("\n") },
			{ type: "toolCall", id: "workflow", name: "subagent", arguments: { workflow: true } },
		]);
		const saved = JSON.stringify(source);
		const native = new AssistantMessageComponent(source);
		const tool = new ToolExecutionComponent("subagent", "workflow", { workflow: true }, undefined, undefined, f.tui, "/tmp");
		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: "WORKFLOW_RESULT" }], isError: false });
		f.chat.addChild(native);
		f.chat.addChild(tool);
		const compact = lines(f.document);
		assert.doesNotMatch(compact.join("\n"), /WORKFLOW_SOURCE|WORKFLOW_RESULT/);
		assert.equal(compact.filter((line) => line.includes("Worked")).length, 1);
		const row = compact.findIndex((line) => line.includes("Worked"));
		click(f.projection, row);
		const expanded = lines(f.document).join("\n");
		assert.equal(expanded.match(/WORKFLOW_SOURCE/g)?.length, 1);
		assert.equal(expanded.match(/WORKFLOW_RESULT/g)?.length, 1);
		click(f.projection, row);
		assert.doesNotMatch(lines(f.document).join("\n"), /WORKFLOW_SOURCE|WORKFLOW_RESULT/);
		assert.equal(JSON.stringify(source), saved);
		f.unmount();
		assert.match(lines(f.document).join("\n"), /WORKFLOW_SOURCE/);
		assert.match(lines(f.document).join("\n"), /WORKFLOW_RESULT/);
	});
}

test("workflow splitting preserves surrounding prose, native styling and padding", () => {
	const f = fixture();
	const text = ["# Before workflow", "", "```js workflow", 'return "WORKFLOW_SOURCE";', "```", "", "After workflow"].join("\r\n");
	const source = message([{ type: "text", text }]);
	const saved = JSON.stringify(source);
	const markdownTheme = { ...getMarkdownTheme(), heading: (text: string) => `NATIVE_HEADING ${text}` };
	const native = new AssistantMessageComponent(source, false, markdownTheme, undefined, 3);
	const original = lines(native);
	f.chat.addChild(native);
	const compact = lines(f.document);
	assert.doesNotMatch(compact.join("\n"), /WORKFLOW_SOURCE/);
	for (const marker of ["NATIVE_HEADING", "After workflow"])
		assert.equal(compact.find((line) => line.includes(marker)), original.find((line) => line.includes(marker)));
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	assert.match(lines(f.document).join("\n"), /WORKFLOW_SOURCE/);
	assert.equal(JSON.stringify(source), saved);
});

test("whole-message transforms run before folding and cross-span references retain their native context", () => {
	const fence = "```";
	for (const kind of ["transformer", "reference"] as const) {
		const f = fixture();
		const text = kind === "transformer"
			? ["Before.", fence + "js workflow", "return 'CONTEXT_SOURCE';", fence, "After."].join("\n")
			: ["See [reference][id].", "", fence + "js workflow", "return 'CONTEXT_SOURCE';", fence, "", "[id]: https://example.com"].join("\n");
		const native = new AssistantMessageComponent(message([{ type: "text", text }]), false, undefined, undefined, 1,
			kind === "transformer" ? [(text) => text + "\n\nNATIVE_FOOTER"] : []);
		const original = native.render(80);
		f.chat.addChild(native);
		const rendered = f.document.render(80);
		if (kind === "transformer") {
			assert.equal(rendered.join("\n").match(/NATIVE_FOOTER/g)?.length, 1);
			assert.doesNotMatch(rendered.join("\n"), /CONTEXT_SOURCE/);
			native.updateContent(message([{ type: "text", text }]), true);
			assert.match(lines(f.document).join("\n"), /Working.*Workflow source/);
			native.updateContent(message([{ type: "text", text }]), false);
			click(f.projection, lines(f.document).findIndex((line) => line.includes("Worked")));
			assert.equal(f.document.render(80).join("\n").match(/NATIVE_FOOTER/g)?.length, 1);
			assert.match(f.document.render(80).join("\n"), /CONTEXT_SOURCE/);
		} else {
			assert.ok(rendered.join("\n").includes("https://example.com"), "reference destination must survive");
			assert.deepEqual(rendered, original, "retain the whole native Markdown context");
			assert.match(rendered.join("\n"), /CONTEXT_SOURCE/, "fallback keeps source available");
		}
	}
});

test("workflow transforms preserve whole-source context, indentation, width and invalidation", () => {
	const f = fixture();
	const fence = "```";
	const text = ["Before.", fence + "js workflow", "return 'PIPELINE_SOURCE';", fence, "After."].join("\n");
	let suffix = "FIRST";
	const native = new AssistantMessageComponent(message([{ type: "text", text }]), false, undefined, undefined, 3, [
		() => { throw new Error("Native transformer failures retain the preceding Markdown"); },
		(markdown, context) => {
			assert.equal(markdown, text);
			assert.equal(context.messageType, "assistant");
			return "    INDENTED_PREFIX\n\n" + markdown + "\n\nGLOBAL_FOOTER_" + suffix + "_" + context.availableWidth;
		},
	]);
	const original = lines(native);
	f.chat.addChild(native);
	const compact = lines(f.document);
	assert.equal(compact.find((line) => line.includes("INDENTED_PREFIX")), original.find((line) => line.includes("INDENTED_PREFIX")));
	assert.match(compact.join("\n"), /GLOBAL_FOOTER_FIRST_74/);
	assert.doesNotMatch(compact.join("\n"), /PIPELINE_SOURCE/);
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	assert.match(lines(f.document).join("\n"), /PIPELINE_SOURCE/);
	assert.match(lines(f.document, 60).join("\n"), /GLOBAL_FOOTER_FIRST_54/);
	suffix = "SECOND";
	f.projection.invalidate();
	const updated = lines(f.document, 60).join("\n");
	assert.match(updated, /GLOBAL_FOOTER_SECOND_54/);
	assert.doesNotMatch(updated, /GLOBAL_FOOTER_FIRST/);
	assert.equal(updated.match(/GLOBAL_FOOTER_/g)?.length, 1);
	assert.match(updated, /PIPELINE_SOURCE/, "invalidation retains disclosure state");
});

test("width-dependent prefixes preserve workflow disclosure and completed-turn boundaries", () => {
	const f = fixture();
	const fence = "```";
	const source = message([{ type: "text", text: [fence + "js workflow", "return 'WIDTH_SOURCE';", fence].join("\n") }]);
	f.chat.addChild(new AssistantMessageComponent(source, false, undefined, undefined, 1, [
		(markdown, context) => context.availableWidth < 70 ? "Narrow layout.\n\n" + markdown : markdown,
	]));
	const compact = lines(f.document);
	click(f.projection, compact.findIndex((line) => line.includes("Worked")));
	f.projection.beginTurn();
	const resized = lines(f.document, 60).join("\n");
	assert.match(resized, /Narrow layout/);
	assert.match(resized, /WIDTH_SOURCE/, "resizing must not close an expanded workflow");
	assert.match(resized, /Worked/);
	assert.doesNotMatch(resized, /Working/, "a completed source is not part of the next turn");
});

test("workflow source streams open and folds once complete", () => {
	const f = fixture();
	const source = (body: string) => message([{ type: "text", text: "Preparing.\n\n```js workflow\n" + body }]);
	const native = new AssistantMessageComponent();
	native.updateContent(source('const first = "STREAM_ONE";'), true);
	f.chat.addChild(native);
	let rendered = lines(f.document).join("\n");
	assert.match(rendered, /Preparing\./);
	assert.match(rendered, /Working.*Workflow source/);
	assert.match(rendered, /STREAM_ONE/);
	native.updateContent(source('const first = "STREAM_ONE";\nreturn "STREAM_TWO";'), true);
	assert.match(lines(f.document).join("\n"), /STREAM_TWO/);
	native.updateContent(source('const first = "STREAM_ONE";\nreturn "STREAM_THREE";\n```'), false);
	const compact = lines(f.document);
	assert.doesNotMatch(compact.join("\n"), /STREAM_ONE|STREAM_THREE/);
	const row = compact.findIndex((line) => line.includes("Worked"));
	click(f.projection, row);
	assert.match(lines(f.document).join("\n"), /STREAM_THREE/);
	click(f.projection, row);
	assert.doesNotMatch(lines(f.document).join("\n"), /STREAM_ONE|STREAM_THREE/);
});


test("ordinary code, nested workflow examples and incomplete final fences remain native content", () => {
	for (const text of [
		"```js\nconst ORDINARY_SOURCE = 1;\n```",
		"````markdown\n```js workflow\nconst ORDINARY_SOURCE = 1;\n```\n````",
		"~~~~markdown\n```javascript workflow\nconst ORDINARY_SOURCE = 1;\n```\n~~~~",
		"```js workflow\nconst ORDINARY_SOURCE = 1;",
	]) {
		const f = fixture();
		f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text }])));
		const rendered = lines(f.document).join("\n");
		assert.match(rendered, /ORDINARY_SOURCE/);
		assert.doesNotMatch(rendered, /Worked|Working/);
	}
});

test("workflow fences leave native error, abort and truncation notices visible", () => {
	for (const stopReason of ["error", "aborted", "length"] as const) {
		const f = fixture();
		f.chat.addChild(new AssistantMessageComponent({
			...message([{ type: "text", text: "```js workflow\nreturn 'FAILED_SOURCE';\n```" }]),
			stopReason, errorMessage: "FAILED_NOTICE",
		}));
		const rendered = lines(f.document).join("\n");
		assert.match(rendered, /FAILED_SOURCE/);
		assert.match(rendered, stopReason === "length" ? /truncated/ : /FAILED_NOTICE/);
		assert.doesNotMatch(rendered, /Worked|Working/);
	}
});

test("regular mode keeps workflow source and native scrollback content untouched", () => {
	const f = fixture(undefined, undefined, undefined, "regular");
	f.chat.addChild(new AssistantMessageComponent(message([
		{ type: "text", text: "```js workflow\nreturn 'REGULAR_SOURCE';\n```" },
	])));
	assert.match(lines(f.document).join("\n"), /REGULAR_SOURCE/);
	assert.doesNotMatch(lines(f.document).join("\n"), /Worked|Working/);
});

test("native thinking and tool rows collapse together and expand with their original content", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**Inspect source**\n\nDetailed reasoning." }]),
	);
	const tool = new ToolExecutionComponent(
		"exec_command",
		"one",
		{ cmd: "cat file" },
		undefined,
		undefined,
		f.tui,
		"/tmp",
	);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "original output" }], isError: false });
	f.chat.addChild(thought);
	f.chat.addChild(tool);
	const compact = lines(f.document);
	assert.equal((compact.filter(Boolean)).length, 1);
	assert.ok((compact.join("\n")).includes("Inspect source"));
	assert.ok((compact.join("\n")).includes("2 steps"));
	assert.ok(!(compact.join("\n")).includes("Detailed reasoning."));
	assert.ok(!(compact.join("\n")).includes("original output"));
	click(f.projection, 1);
	const expanded = lines(f.document).join("\n");
	assert.ok((expanded).includes("Detailed reasoning."));
	assert.ok((expanded).includes("original output"));
	click(f.projection, 1);
	assert.equal((lines(f.document).filter(Boolean)).length, 1);
	f.unmount();
	assert.equal(f.document.children[2], f.chat);
	assert.ok((lines(f.document).join("\n")).includes("original output"));
});

test("active work streams open and folds once prose follows or the turn settles", () => {
	const f = fixture();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([{ type: "thinking", thinking: "**Previous turn**\n\nHistorical details." }]),
		),
	);
	f.chat.addChild(new Text("Next user request", 0, 0));
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**Current work**\n\nLive reasoning." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	let rendered = lines(f.document).join("\n");
	assert.ok(rendered.includes("Working for 0s · Current work · 1 step"));
	assert.ok(rendered.includes("Live reasoning."));
	assert.ok(!rendered.includes("Historical details."), "restored history stays folded");
	thought.updateContent(source, false);
	const tool = new ToolExecutionComponent("read", "live", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "Live tool progress" }], isError: false }, true);
	f.chat.addChild(tool);
	rendered = lines(f.document).join("\n");
	assert.ok(rendered.includes("Working · Current work · 2 steps"));
	assert.ok(rendered.includes("Live reasoning."));
	assert.ok(rendered.includes("Live tool progress"));
	tool.updateResult({ content: [{ type: "text", text: "Completed tool output" }], isError: false });
	// The group stays live between tool completion and the next model request.
	rendered = lines(f.document).join("\n");
	assert.ok(rendered.includes("Working · Current work · 2 steps"));
	assert.ok(rendered.includes("Completed tool output"));
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Checking the result." }])));
	// Prose after the group folds it, even before the turn settles.
	f.projection.beginTurn();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Verify result**\n\nFollow-up detail." }])),
	);
	rendered = lines(f.document).join("\n");
	assert.ok(!rendered.includes("Live reasoning."));
	assert.ok(!rendered.includes("Completed tool output"));
	assert.ok(rendered.includes("Follow-up detail."));
	assert.ok(rendered.includes("Worked · Current work · 2 steps"));
	assert.ok(rendered.includes("Working · Verify result · 1 step"));
	assert.ok(rendered.includes("Checking the result."));
	f.projection.finishTurn();
	rendered = lines(f.document).join("\n");
	assert.ok(!rendered.includes("Live reasoning."));
	assert.ok(!rendered.includes("Completed tool output"));
	assert.ok(!rendered.includes("Follow-up detail."));
	assert.ok(rendered.includes("Current work · 2 steps"));
	assert.ok(rendered.includes("Verify result · 1 step"));
	assert.ok(!rendered.includes("Working"));
	assert.ok(rendered.includes("Checking the result."));
	// Starting another turn leaves the finished folds alone.
	f.projection.beginTurn();
	assert.equal(lines(f.document).join("\n"), rendered);
	f.unmount();
});

/** Pi's fullscreen follow state, with libtui's viewport pin standing in for disableFollow. */
function followingHost(tui: object, initiallyFollowing: boolean) {
	const state = { following: initiallyFollowing };
	Object.defineProperty(tui, "isFollowingOutput", { configurable: true, get: () => state.following });
	Object.assign(tui, { scrollToBottom: () => { state.following = true; } });
	const registry = getMouseRegistryState(ensureMouseRegistry());
	const previous = registry.viewportPreserver;
	registry.viewportPreserver = () => { state.following = false; };
	cleanups.push(() => { registry.viewportPreserver = previous; });
	return state;
}

test("automatic folds keep following live output; scrolled-back views and clicks stay pinned", () => {
	for (const initiallyFollowing of [true, false]) {
		const f = fixture();
		const host = followingHost(f.tui, initiallyFollowing);
		f.projection.beginTurn();
		const thought = new AssistantMessageComponent();
		thought.updateContent(message([{ type: "thinking", thinking: "**Follow**\n\nFOLLOW_DETAIL" }]), true);
		f.chat.addChild(thought);
		assert.match(lines(f.document).join("\n"), /FOLLOW_DETAIL/);
		assert.equal(host.following, initiallyFollowing, "automatic open");
		thought.updateContent(message([{ type: "thinking", thinking: "**Follow**\n\nFOLLOW_DETAIL" }]), false);
		f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Answer." }])));
		assert.doesNotMatch(lines(f.document).join("\n"), /FOLLOW_DETAIL/);
		assert.equal(host.following, initiallyFollowing, "automatic close");
		host.following = true;
		click(f.projection, lines(f.document).findIndex((line) => line.includes("Worked")));
		assert.match(lines(f.document).join("\n"), /FOLLOW_DETAIL/);
		assert.equal(host.following, false, "a click keeps libtui's pinned viewport");
		f.unmount();
	}
});

test("interrupted work stays open until a later turn settles normally", () => {
	const f = fixture();
	f.projection.beginTurn();
	const tool = new ToolExecutionComponent("read", "aborted", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "ABORTED_PROGRESS" }], isError: false }, true);
	f.chat.addChild(tool);
	assert.match(lines(f.document).join("\n"), /ABORTED_PROGRESS/);
	tool.updateResult({ content: [{ type: "text", text: "ABORTED_PROGRESS" }], isError: true });
	f.chat.addChild(new AssistantMessageComponent({ ...message([]), stopReason: "aborted" }));
	let rendered = lines(f.document).join("\n");
	assert.match(rendered, /ABORTED_PROGRESS/, "the abort notice does not fold the work it interrupted");
	assert.doesNotMatch(rendered, /Working/);
	f.projection.finishTurn(true);
	assert.match(lines(f.document).join("\n"), /ABORTED_PROGRESS/);
	// Work that ends at an interrupted settle without a notice also stays open.
	f.chat.addChild(new Text("Retry request", 0, 0));
	f.projection.beginTurn();
	const retry = new ToolExecutionComponent("read", "trailing", {}, undefined, undefined, f.tui, "/tmp");
	retry.markExecutionStarted();
	retry.updateResult({ content: [{ type: "text", text: "TRAILING_PROGRESS" }], isError: false });
	f.chat.addChild(retry);
	assert.match(lines(f.document).join("\n"), /TRAILING_PROGRESS/);
	f.projection.finishTurn(true);
	rendered = lines(f.document).join("\n");
	assert.match(rendered, /ABORTED_PROGRESS/);
	assert.match(rendered, /TRAILING_PROGRESS/);
	// A normal settle folds both, including work from earlier turns.
	f.chat.addChild(new Text("Next request", 0, 0));
	f.projection.beginTurn();
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "All good." }])));
	f.projection.finishTurn();
	rendered = lines(f.document).join("\n");
	assert.doesNotMatch(rendered, /ABORTED_PROGRESS|TRAILING_PROGRESS/);
	assert.match(rendered, /All good\./);
	f.unmount();
});

test("an error notice mid-turn holds earlier work open until the retried turn settles", () => {
	const f = fixture();
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	thought.updateContent(message([{ type: "thinking", thinking: "**Before error**\n\nERROR_DETAIL" }]), true);
	f.chat.addChild(thought);
	assert.match(lines(f.document).join("\n"), /ERROR_DETAIL/);
	thought.updateContent(message([{ type: "thinking", thinking: "**Before error**\n\nERROR_DETAIL" }]), false);
	f.chat.addChild(new AssistantMessageComponent({ ...message([]), stopReason: "error", errorMessage: "Overloaded" }));
	assert.match(lines(f.document).join("\n"), /ERROR_DETAIL/);
	// Pi retries within the same settled run.
	f.projection.beginTurn();
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Recovered answer." }])));
	assert.match(lines(f.document).join("\n"), /ERROR_DETAIL/);
	f.projection.finishTurn();
	assert.doesNotMatch(lines(f.document).join("\n"), /ERROR_DETAIL/);
	f.unmount();
});

test("thinking interrupted while streaming stays open, and restored interruptions stay folded", () => {
	const f = fixture();
	f.projection.beginTurn();
	const native = new AssistantMessageComponent();
	const thinking = [{ type: "thinking" as const, thinking: "**Interrupted live**\n\nLIVE_INTERRUPTED_DETAIL" }];
	native.updateContent(message(thinking), true);
	f.chat.addChild(native);
	assert.match(lines(f.document).join("\n"), /LIVE_INTERRUPTED_DETAIL/);
	native.updateContent({ ...message(thinking), stopReason: "aborted" }, false);
	let rendered = lines(f.document).join("\n");
	assert.match(rendered, /LIVE_INTERRUPTED_DETAIL/, "Pi's re-rendered interrupted views keep the work open");
	assert.match(rendered, /Operation aborted|aborted/i);
	f.projection.finishTurn(true);
	assert.match(lines(f.document).join("\n"), /LIVE_INTERRUPTED_DETAIL/);
	f.projection.beginTurn();
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Done." }])));
	f.projection.finishTurn();
	assert.doesNotMatch(lines(f.document).join("\n"), /LIVE_INTERRUPTED_DETAIL/);
	f.unmount();
	// The same interrupted message restored from history keeps the documented fold.
	const restored = fixture();
	restored.chat.addChild(new AssistantMessageComponent({ ...message(thinking), stopReason: "aborted" }));
	assert.doesNotMatch(lines(restored.document).join("\n"), /LIVE_INTERRUPTED_DETAIL/);
	restored.unmount();
});

test("live work expands inline so the newest streamed lines stay visible", () => {
	const f = fixture();
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const body = Array.from({ length: 60 }, (_, index) => `LIVE_LINE_${index}`).join("\n\n");
	const source = message([{ type: "thinking", thinking: "**Long work**\n\n" + body }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	assert.match(lines(f.document).join("\n"), /LIVE_LINE_59/);
	// Live rows are Pi's own rows at full width, without the repainted tool surface.
	const native = thought.render(80);
	const live = f.document.render(80);
	const start = live.indexOf(native[0]!);
	assert.ok(start >= 0);
	assert.deepEqual(live.slice(start, start + native.length), native);
	thought.updateContent(source, false);
	f.projection.finishTurn();
	const done = lines(f.document);
	assert.doesNotMatch(done.join("\n"), /LIVE_LINE_/);
	click(f.projection, done.findIndex((line) => line.includes("Worked")));
	assert.match(lines(f.document).join("\n"), /LIVE_LINE_59/, "manual expansion is inline too");
	f.unmount();
});


test("streamed updates stay visible and a user's reopened fold survives completion", () => {
	const f = fixture();
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**First step**\n\nDetails." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	let rendered = lines(f.document).join("\n");
	assert.ok(rendered.includes("First step"));
	assert.ok(rendered.includes("Details."));
	// Pi may reuse the same streamed message object.
	source.content = [{ type: "thinking", thinking: "**Second step**\n\nMore detail." }];
	thought.updateContent(source, true);
	rendered = lines(f.document).join("\n");
	assert.ok(rendered.includes("Second step"));
	assert.ok(rendered.includes("More detail."));
	// Closing and reopening is an explicit choice that completion must respect.
	click(f.projection, 1);
	assert.ok(!lines(f.document).join("\n").includes("More detail."));
	click(f.projection, 1);
	assert.ok(lines(f.document).join("\n").includes("More detail."));
	thought.updateContent(source, false);
	f.projection.beginTurn();
	assert.ok(lines(f.document).join("\n").includes("More detail."));
	f.projection.finishTurn();
	assert.ok(lines(f.document).join("\n").includes("More detail."));
	assert.ok(!lines(f.document).join("\n").includes("●"));
	click(f.projection, 1);
	assert.ok(!lines(f.document).join("\n").includes("More detail."));
	f.unmount();
});


test("compaction becomes one full-width divider with an independent summary disclosure", () => {
	const f = fixture();
	f.chat.addChild(new Text("Earlier conversation", 0, 0));
	const native = new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: "**Saved context**\n\nOriginal summary content.",
		tokensBefore: 257_174,
		timestamp: 0,
	});
	// Pi's global tool expansion must not expand our context disclosure.
	native.setExpanded(true);
	f.chat.addChild(native);
	const collapsed = lines(f.document, 100);
	assert.equal((collapsed).length, 2);
	assert.ok((collapsed[1]).startsWith("── Context compacted · 257,174 tokens before "));
	assert.ok((collapsed[1]).includes("───"));
	assert.equal(visibleWidth(collapsed[1]!), 100);
	assert.ok(!(collapsed.join("\n")).includes("Original summary content"));
	assert.ok(!(collapsed.join("\n")).includes("[compaction]"));
	click(f.projection, 1);
	assert.ok((lines(f.document).join("\n")).includes("Original summary content."));
	f.chat.addChild(new Text("Work continues", 0, 0));
	assert.ok((lines(f.document).join("\n")).includes("Original summary content."));
	click(f.projection, 1);
	assert.ok(!(lines(f.document).join("\n")).includes("Original summary content."));
	for (const width of [1, 2, 8, 40, 100]) {
		const divider = lines(f.projection, width)[1]!;
		assert.equal(visibleWidth(divider), width);
	}
	f.unmount();
	assert.ok((f.chat.children).includes(native));
	assert.ok((lines(f.document).join("\n")).includes("[compaction]"));
});

test("compaction separates activity without resetting an existing open fold", () => {
	const f = fixture();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Before**\n\nEarlier detail." }])),
	);
	lines(f.document);
	click(f.projection, 1);
	f.chat.addChild(
		new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Summary.",
			tokensBefore: 100,
			timestamp: 0,
		}),
	);
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**After**\n\nLater detail." }])),
	);
	const rendered = lines(f.document).join("\n");
	assert.ok((rendered).includes("Earlier detail."));
	assert.ok((rendered).includes("Before · 1 step"));
	assert.ok((rendered).includes("After · 1 step"));
	assert.ok(!(rendered).includes("Later detail."));
	assert.ok(!(rendered).includes("Summary."));
	f.unmount();
});

test("tools retain the latest thinking summary while running and after completion", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**First step**\n\nDetails.\n\n**Implement marker helper**\n\nNext." }]),
	);
	f.chat.addChild(thought);
	const tool = new ToolExecutionComponent("exec", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	// The open live body shows the tool itself; the header keeps the thinking summary.
	const running = lines(f.document).find((line) => line.includes("2 steps"));
	assert.ok(running);
	assert.ok(running.includes("Implement marker helper"));
	assert.ok(!running.includes("exec"));
	tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	assert.ok((lines(f.document).join("\n")).includes("Implement marker helper"));
	const next = new AssistantMessageComponent();
	next.updateContent(message([{ type: "thinking", thinking: "**Verify marker rendering**" }]), true);
	f.chat.addChild(next);
	assert.ok((lines(f.document).join("\n")).includes("Verify marker rendering"));
	f.unmount();
});

test("tool summaries use live semantic fields without flattening or pre-truncating custom renderers", () => {
	const f = fixture();
	let headerRenders = 0;
	let payloadRenders = 0;
	const detail = `${"long/path/".repeat(12)}transcript.ts`;
	const activity = new ToolActivity({
		theme,
		requestRender: () => {},
		action: {
			render: () => {
				headerRenders++;
				return ["Explored", "  └ Read truncated…"];
			},
			invalidate() {},
		},
		view: {
			action: { verb: "Read", detail, status: "succeeded" },
			payload: {
				kind: "component",
				preview: {
					render: () => {
						payloadRenders++;
						return ["original tool output"];
					},
					invalidate() {},
				},
			},
		},
	});
	const tool = new ToolExecutionComponent(
		"exec",
		"one",
		{},
		undefined,
		{ renderResult: () => activity },
		f.tui,
		"/tmp",
	);
	tool.updateResult({ content: [], isError: false });
	f.chat.addChild(tool);
	const compact = lines(f.document, 200).join("\n");
	assert.ok((compact).includes(`Read · ${detail}`));
	assert.doesNotMatch(compact, /[└…]/u);
	assert.equal(headerRenders, 0);
	assert.equal(payloadRenders, 0);
	// Nested renderers can update independently of the enclosing Pi result.
	activity.update({ action: { verb: "Verified", detail: "transcript.ts", status: "succeeded" } });
	assert.ok((lines(f.document).join("\n")).includes("Verified · transcript.ts"));
	click(f.projection, 1);
	assert.ok((lines(f.document).join("\n")).includes("Explored"));
	assert.ok((headerRenders) > (0));
	f.unmount();
	activity.dispose();
});

test("prose separates folds and tool failures stay inside expansion after completion", () => {
	const f = fixture();
	f.projection.beginTurn();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([
				{ type: "thinking", thinking: "**Check files**\n\nLonger thought." },
				{ type: "text", text: "Here is my answer." },
			]),
		),
	);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: "build failure details" }], isError: true });
	f.chat.addChild(tool);
	const live = lines(f.document);
	assert.ok(live.join("\n").includes("Here is my answer."));
	assert.ok(live.join("\n").includes("Check files"));
	assert.ok(!live.join("\n").includes("Longer thought."));
	const header = live.find((row) => row.includes("Working · build · 1 step"));
	assert.ok(header);
	assert.doesNotMatch(header, /failed|Failed/);
	assert.ok(live.join("\n").includes("build failure details"), "live work stays open");
	f.projection.finishTurn();
	const completed = lines(f.document);
	assert.ok((completed.join("\n")).includes("Worked · build · 1 step"));
	assert.ok(!(completed.join("\n")).includes("Failed"));
	assert.ok(!(completed.join("\n")).includes("build failure details"));
	click(
		f.projection,
		completed.findIndex((row) => row.includes("Worked · build")),
	);
	assert.ok((lines(f.document).join("\n")).includes("build failure details"));
	f.unmount();
});


for (const count of [1, 10]) test(`${count} failed calls stay open while work continues and a manual fold holds`, () => {
	const f = fixture();
	f.projection.beginTurn();
	const output = `Partially edited files\n${"@@ patch diff\n+added line\n-removed line\n".repeat(30)}Script error: failed patch`;
	for (let index = 0; index < count; index++) {
		const tool = new ToolExecutionComponent("codemode", `failed-${index}`, {}, undefined, undefined, f.tui, "/tmp");
		tool.updateResult({ content: [{ type: "text", text: output }], isError: true });
		f.chat.addChild(tool);
	}
	const live = lines(f.document);
	const header = live.find((line) => line.includes("Working · codemode"));
	assert.ok(header);
	assert.doesNotMatch(header, /failed|Failed/);
	assert.ok(live.join("\n").includes("Partially edited files"));
	assert.ok(live.join("\n").includes("Script error"));
	click(f.projection, 1);
	assert.equal(lines(f.document).filter(Boolean).length, 1);
	const continuing = new ToolExecutionComponent("read", "continuing", {}, undefined, undefined, f.tui, "/tmp");
	continuing.markExecutionStarted();
	f.chat.addChild(continuing);
	assert.ok((lines(f.document).join("\n")).includes("Working · read"));
	assert.equal(lines(f.document).filter(Boolean).length, 1, "the user's fold holds while work continues");
	click(f.projection, 1);
	assert.ok((lines(f.document).join("\n")).includes("Partially edited files"));
	assert.ok((lines(f.document).join("\n")).includes("patch diff"));
	click(f.projection, 1);
	assert.equal((lines(f.document).filter(Boolean)).length, 1);
	f.unmount();
});


test("retains unknown nodes and native error notices; detach stops animation without owning native tools", () => {
	const mounts = sharedMotionScheduler.activeMountCount;
	const f = fixture();
	f.chat.addChild(new Text("unknown notice", 0, 0));
	const failed = new AssistantMessageComponent({
		...message([{ type: "thinking", thinking: "Interrupted thought" }]),
		stopReason: "error",
		errorMessage: "network failed",
	});
	f.chat.addChild(failed);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	const rendered = lines(f.document).join("\n");
	assert.ok((rendered).includes("unknown notice"));
	assert.ok((rendered).includes("network failed"));
	f.unmount();
	assert.equal(sharedMotionScheduler.activeMountCount, mounts);
	assert.ok((f.chat.children).includes(tool));
});

test("unsupported roots and duplicate mounts leave the host unchanged", () => {
	const tui = new TestTui(new ProcessTerminal());
	assert.equal(mountTranscriptProjection(tui, () => {
			throw new Error("must not run");
		}), undefined);
	const f = fixture();
	assert.equal(mountTranscriptProjection(f.tui, () => {
			throw new Error("must not run");
		}), undefined);
	f.unmount();
	const release = mountTranscriptProjection(f.tui, (entries) => new ActivityTranscript(entries, theme, () => {}));
	assert.notEqual(release, undefined);
	release?.();
});

test("summary uses the latest supplied heading, bounds text and strips control sequences", () => {
	const part: TranscriptEntry = {
		kind: "thinking",
		key: {},
		component: new Container(),
		running: false,
		failed: false,
		summary: "**Old**\n\nPrior.\n\n**Latest**\n\nCurrent.",
	};
	assert.equal(activitySummary(part), "Latest");
	const text = activitySummary({ ...part, summary: `\x1b]52;c;secret\x07${"word ".repeat(1000)}` });
	assert.ok(!(text).includes("\x1b"));
	assert.ok((text.length) <= (241));
	const transcript = new ActivityTranscript(
		() => [part],
		theme,
		() => {},
	);
	for (const width of [1, 2, 8, 40])
		assert.equal(transcript.render(width).every((row) => visibleWidth(row) <= width), true);
	transcript.dispose();
});

test("muted, underlined rows retain saved wall time across parallel tools and reloads", () => {
	// Chalk disables attributes without a TTY; exercise the terminal theme contract.
	const styledTheme = Object.create(theme) as Theme;
	styledTheme.underline = (text: string) => `\x1b[4m${text}\x1b[24m`;
	styledTheme.italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
	const source = {
		...message([
			{ type: "thinking", thinking: "**Checking index baseline**" },
			{ type: "toolCall", id: "one", name: "read", arguments: {} },
			{ type: "toolCall", id: "two", name: "read", arguments: {} },
		]),
		timestamp: 1_000,
	};
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: new Date(3_000).toISOString(),
			message: source,
		},
	];
	const result = (id: string, timestamp: number): SessionEntry => ({
		type: "message",
		id,
		parentId: "assistant",
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp },
	});
	const timings = new ActivityTimings();
	timings.load(branch);
	let now = 11_000;
	const f = fixture(timings, () => now, styledTheme);
	f.projection.beginTurn();
	f.chat.addChild(new AssistantMessageComponent(source));
	const tools: ToolExecutionComponent[] = [];
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, f.tui, "/tmp");
		tool.markExecutionStarted();
		f.chat.addChild(tool);
		tools.push(tool);
	}
	assert.ok((lines(f.document).join("\n")).includes("Working for 10s · Checking index baseline · 3 steps"));
	now = 66_000;
	assert.ok((lines(f.document).join("\n")).includes("Working for 1m 5s · Checking index baseline · 3 steps"));
	branch.push(result("one", 101_000), result("two", 417_000));
	timings.load(branch);
	for (const tool of tools) tool.updateResult({ content: [], isError: false });
	now = 418_000;
	// The live timer includes gaps between completed tools and the next request.
	assert.ok((lines(f.document).join("\n")).includes("Working for 6m 57s · Checking index baseline · 3 steps"));
	f.projection.finishTurn();
	assert.ok((lines(f.document).join("\n")).includes("Worked for 6m 56s · Checking index baseline · 3 steps"));
	f.unmount();
	// Rebuilding native components must use saved timestamps, not their mount time.
	timings.load(branch);
	const reloaded = fixture(timings, () => 999_000, styledTheme);
	reloaded.chat.addChild(new AssistantMessageComponent(source));
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, reloaded.tui, "/tmp");
		tool.updateResult({ content: [], isError: false });
		reloaded.chat.addChild(tool);
	}
	const rows = reloaded.document.render(100);
	const row = rows.find((line) => stripTerminalSequences(line).includes("Worked for"))!;
	assert.ok((stripTerminalSequences(row)).startsWith("  Worked for 6m 56s · Checking index baseline · 3 steps"));
	assert.ok((row).startsWith(tuiTheme(styledTheme).fgAnsi("text.muted")));
	assert.ok((row).includes(styledTheme.italic("Checking index baseline")));
	assert.ok((row).includes("\x1b[4:4m"));
	assert.equal(visibleWidth(row), 100);
	const padding = " ".repeat(100 - visibleWidth(stripTerminalSequences(row).trimEnd()));
	assert.ok((padding.length) > (20));
	assert.ok((row).includes(tuiTheme(styledTheme).fg("text.muted", padding)));
	assert.ok((row).includes(`${padding}\x1b[39m\x1b[24m`));
	assert.ok(!(row).includes("\x1b[1m"));
	assert.doesNotMatch(stripTerminalSequences(row), /[•●]/u);
	for (const width of [1, 2, 8, 40])
		assert.equal(reloaded.document.render(width).every((line) => visibleWidth(line) <= width), true);
	reloaded.unmount();
	timings.load([]);
	assert.equal(timings.elapsed(
			[
				{
					kind: "thinking",
					key: {},
					component: new Container(),
					summary: "Old",
					timestamp: 1_000,
					running: false,
					failed: false,
				},
			],
			999_000,
		), undefined);
});

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("test-collapse-transcript", {
		description: "Offline inherited folding contract assertions",
		handler: async (_args, ctx) => {
			theme = ctx.ui.theme;
			initTheme("dark", false);
			try {
				for (const { name, run } of cases) {
					try {
						await run();
					console.log(`PASS ${name}`);
					} finally {
						for (const cleanup of cleanups.splice(0).reverse()) cleanup();
						configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
					}
				}
				console.log("COLLAPSE_TRANSCRIPT_TESTS_PASSED");
			} catch (error) {
				console.error(error);
				process.exitCode = 1;
			} finally {
				ctx.shutdown();
			}
		},
	});
}
