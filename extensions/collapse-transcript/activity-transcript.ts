import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	type MotionMount,
	sanitizeTuiFieldPreview,
	sharedMotionScheduler,
	tuiTheme,
} from "@luan.sh/pi-libtui";
import { ToolActivity, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";
import { foldTargetAt } from "@luan.sh/pi-libtui/folding";
import { ActivityTimings, formatActivityDuration } from "./activity-timing.ts";
import { CompactionSection } from "./compaction-section.ts";
import { renderToolImages, ToolImageActions } from "./native-tool-images.ts";
import type { ViewableImage } from "./image-viewer.ts";
import { AssistantSources } from "./assistant-sources.ts";
import { InterruptedThinking, isInterruptionNotice } from "./interrupted-thinking.ts";

type ActivityEntry = Extract<TranscriptEntry, { kind: "thinking" | "tool" }>;

/** Use a provider's latest heading or paragraph; do not invent a reasoning summary. */
export function activitySummary(entry: ActivityEntry): string {
	if (entry.kind === "tool") return sanitizeTuiFieldPreview(entry.summary.replace(/^[^\p{L}\p{N}$]+/u, ""), 240);
	const tail = entry.summary.slice(-8_000);
	const headings = [...tail.matchAll(/(?:^|\n)\s*(?:\*\*([^\n]+?)\*\*|#{1,6}\s+([^\n]+))/gu)];
	const heading = headings.at(-1);
	const paragraph = tail
		.trim()
		.split(/\n\s*\n/u)
		.at(-1)
		?.split("\n")[0];
	return sanitizeTuiFieldPreview(heading?.[1] ?? heading?.[2] ?? paragraph ?? "Thinking", 240);
}

class ActivitySection extends ComponentStack {
	private readonly body = new ComponentStack();
	private readonly interactiveBody: ToolImageActions;
	private readonly preview = new Spacer(0);
	private readonly activity: ToolActivity;
	private entries: readonly ActivityEntry[] = [];
	private clock: MotionMount | undefined;
	private summary = "";
	private running = false;
	/** Live work opens and closes itself until the user toggles this fold. */
	private autoFold = true;
	private seenFolded: boolean | undefined;
	/** Work stopped by an error, abort or truncation stays open until a later turn settles normally. */
	private awaitingRecovery = false;
	private readonly spacer = new Spacer(1);
	private readonly layout: Component[];

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings: ActivityTimings,
		private readonly now: () => number,
		openImage: (image: ViewableImage) => void,
		private readonly keepFollowing: (change: () => void) => void,
	) {
		super();
		this.interactiveBody = new ToolImageActions(this.body, () => this.entries, openImage);
		this.activity = new ToolActivity({
			theme,
			requestRender,
			action: { render: (width) => this.renderHeader(width), invalidate() {} },
			view: { action: { verb: "Working", status: "running" } },
			// Expand inline like Pi's native transcript instead of a top-anchored scroll box.
			maxHeight: Number.MAX_SAFE_INTEGER,
		});
		this.layout = [
			this.spacer,
			this.activity,
			// One stable image sibling per section, outside the clickable fold body.
			new ToolImageActions({
				render: (width) => {
					if (!this.activity.children.some((child) => foldTargetAt(child, 0)?.isFolded())) return [];
					const lines = renderToolImages(this.entries, width);
					if (lines.length) lines.push(truncateToWidth(this.theme.fg("dim", "  Click image to open · /images"), width));
					return lines;
				},
				// The original tools own image invalidation, including while folded.
				invalidate() {},
			}, () => this.entries, openImage),
		];
		this.setChildren(this.layout);
	}

	update(entries: readonly ActivityEntry[], active: boolean, interrupted = false): void {
		const running = active || entries.some((entry) => entry.running);
		const wasRunning = this.running;
		const created = this.entries.length === 0;
		if (
			running === this.running &&
			entries.length === this.entries.length &&
			entries.every((entry, index) => entry === this.entries[index])
		)
			return;
		this.entries = entries;
		this.body.setChildren(entries.map((entry) => entry.component));
		// Keep the model's intent visible while tools run and after they finish.
		const latest =
			entries.filter((entry) => entry.kind === "thinking" && entry.summary.trim()).at(-1) ?? entries.at(-1)!;
		this.summary = activitySummary(latest);
		this.running = running;
		if (running && !this.clock)
			this.clock = sharedMotionScheduler.mount({ requestRender: this.requestRender }, { cadenceMs: 1_000 });
		else if (!running) {
			this.clock?.dispose();
			this.clock = undefined;
		}
		this.activity.update({
			action: {
				verb: this.summary,
				// A failed tool is not a failed request; native request errors remain separate entries.
				status: running ? "running" : "succeeded",
				marker: false,
			},
			running,
			payload: { kind: "component", preview: this.preview, full: this.interactiveBody },
		});
		// Show work while it runs; fold it once prose follows or the turn settles.
		if (running !== wasRunning) this.followActivity(running, interrupted);
		// Pi re-renders an interrupted message as new views, so its work can arrive already stopped.
		else if (created && interrupted) {
			this.followActivity(true);
			this.awaitingRecovery = this.autoFold;
		}
	}

	/** A normal settle folds work that an earlier interruption left open, for example after a retry. */
	recover(): void {
		if (!this.awaitingRecovery || this.running) return;
		this.awaitingRecovery = false;
		this.followActivity(false);
	}

	private fold() {
		for (const child of this.activity.children) {
			const target = foldTargetAt(child, 0);
			if (target) return target;
		}
		return undefined;
	}

	/** Any fold change between our own updates came from the user. */
	private observeFold(): void {
		const folded = this.fold()?.isFolded();
		if (folded === undefined) return;
		if (this.seenFolded !== undefined && folded !== this.seenFolded) this.autoFold = false;
		this.seenFolded = folded;
	}

	private followActivity(open: boolean, interrupted = false): void {
		this.observeFold();
		const fold = this.fold();
		if (!fold || !this.autoFold) return;
		this.awaitingRecovery = !open && interrupted;
		if (this.awaitingRecovery) return;
		this.keepFollowing(() => (open ? fold.open() : fold.close()));
		this.seenFolded = fold.isFolded();
	}

	render(width: number): string[] {
		this.observeFold();
		// Open live work renders the native components directly under the header. The expanded
		// tool surface repaints every row whenever streamed content changes, so its cost grows
		// with the section; finished sections keep that surface because they no longer change.
		const header = this.activity.children[0];
		const inline = this.running && this.fold()?.isFolded() === false && header !== undefined;
		this.setChildren(inline ? [this.spacer, header, this.interactiveBody] : this.layout);
		const rows = super.render(width);
		// Extend the underline through the empty columns, not just the disclosure text.
		if (rows[1]) {
			const colors = tuiTheme(this.theme);
			const padding = " ".repeat(Math.max(0, Math.floor(width) - visibleWidth(rows[1])));
			// The chevron closes its foreground; paint the remaining columns explicitly.
			const row = rows[1] + colors.fg("text.muted", padding);
			// Pi exposes only solid underlines; select dotted SGR styling at this terminal boundary.
			const underlined = this.theme.underline(row).replaceAll("\x1b[4m", "\x1b[4:4m");
			rows[1] = colors.fg("text.muted", underlined);
		}
		return rows;
	}

	private renderHeader(width: number): string[] {
		if (width <= 0) return [];
		const elapsed = this.timings.elapsed(this.entries, this.now(), this.running);
		const duration = elapsed === undefined ? "" : ` for ${formatActivityDuration(elapsed)}`;
		const label = `  ${this.running ? "Working" : "Worked"}${duration} · ${this.theme.italic(this.summary)}`;
		const steps = `${this.entries.length} ${this.entries.length === 1 ? "step" : "steps"}`;
		return [truncateToWidth(`${label} · ${steps}`, width, "…")];
	}

	dispose(): void {
		this.clock?.dispose();
		this.activity.dispose();
	}
}

/** Fold consecutive tools/thinking, leaving assistant text and every other message in place. */
export class ActivityTranscript extends ComponentStack {
	private readonly sections = new Map<object, ActivitySection>();
	private readonly compactions = new Map<object, CompactionSection>();
	private completedBeforeTurn: Set<object> | undefined;
	/** Entries that existed before the latest turn began; retained after it settles. */
	private latestTurnStart: Set<object> | undefined;
	private readonly sources = new AssistantSources();
	private readonly interrupted = new InterruptedThinking();
	private lastWidth: number | undefined;
	/** The last settle ended in an error, abort or truncation; its trailing work stays open. */
	private settledInterrupted = false;

	constructor(
		private readonly entries: () => readonly TranscriptEntry[],
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings = new ActivityTimings(),
		private readonly now: () => number = Date.now,
		private readonly tui?: TUI,
		private readonly openImage: (image: ViewableImage) => void = () => {},
	) {
		super();
	}

	/**
	 * libtui pins the viewport on every fold change so a click does not move the clicked row.
	 * Automatic changes must not stop Pi's fullscreen viewport from following new output.
	 * `isFollowingOutput`/`scrollToBottom` are Pi's fullscreen TUI members; absent hosts are left alone.
	 */
	private readonly keepFollowing = (change: () => void): void => {
		const host = this.tui as (TUI & { readonly isFollowingOutput?: boolean; scrollToBottom?(): void }) | undefined;
		const following = host?.isFollowingOutput === true;
		change();
		if (following) host?.scrollToBottom?.();
	};

	private readEntries(): readonly TranscriptEntry[] {
		const entries = this.entries();
		if (this.tui?.mode !== "fullscreen") return entries;
		return this.interrupted.read(this.sources.read(entries, this.tui.mode, this.lastWidth ?? this.tui.terminal.columns));
	}

	invalidate(): void {
		this.sources.invalidate();
		super.invalidate();
	}

	beginTurn(): void {
		// Retries and automatic continuations belong to the same activity group.
		this.completedBeforeTurn ??= new Set(this.readEntries().map((entry) => entry.key));
		this.latestTurnStart = this.completedBeforeTurn;
		this.settledInterrupted = false;
		this.requestRender();
	}

	/** Interrupted turns keep their last work open; the next normal settle folds it. */
	finishTurn(interrupted = false): void {
		this.completedBeforeTurn = undefined;
		this.settledInterrupted = interrupted;
		if (!interrupted) for (const section of this.sections.values()) section.recover();
		this.requestRender();
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const children: Component[] = [];
		const retained = new Set<object>();
		let pending: ActivityEntry[] = [];
		const flush = (active = false, interrupted = false) => {
			if (!pending.length) return;
			const turnStart = this.latestTurnStart;
			// Only the latest turn's work can be held open; restored history keeps its folds.
			interrupted &&= turnStart !== undefined && pending.some((entry) => !turnStart.has(entry.key));
			const key = pending[0]!.key;
			let section = this.sections.get(key);
			if (!section) {
				section = new ActivitySection(
					this.theme,
					this.requestRender,
					this.timings,
					this.now,
					this.openImage,
					this.keepFollowing,
				);
				this.sections.set(key, section);
			}
			section.update(pending, active, interrupted);
			children.push(section);
			retained.add(key);
			pending = [];
		};
		for (const entry of this.readEntries()) {
			if (entry.kind === "thinking" || entry.kind === "tool") pending.push(entry);
			else {
				flush(false, isInterruptionNotice(entry));
				if (entry.kind === "compaction") {
					let section = this.compactions.get(entry.key);
					if (!section) {
						section = new CompactionSection(entry, this.theme, this.requestRender);
						this.compactions.set(entry.key, section);
					}
					retained.add(entry.key);
					children.push(section);
				} else children.push(entry.component);
			}
		}
		const beforeTurn = this.completedBeforeTurn;
		flush(beforeTurn !== undefined && pending.some((entry) => !beforeTurn.has(entry.key)), this.settledInterrupted);
		for (const [key, section] of this.sections) {
			if (retained.has(key)) continue;
			section.dispose();
			this.sections.delete(key);
		}
		for (const [key, section] of this.compactions) {
			if (retained.has(key)) continue;
			section.dispose();
			this.compactions.delete(key);
		}
		this.setChildren(children);
		return super.render(width);
	}

	dispose(): void {
		for (const section of this.sections.values()) section.dispose();
		this.sections.clear();
		for (const section of this.compactions.values()) section.dispose();
		this.compactions.clear();
	}
}
