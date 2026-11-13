# Transcript activity folding

A small fork of [`@luan.sh/pi-collapse-transcript`](https://github.com/luan/agents/tree/main/harnesses/pi/agent/packages/pi-collapse-transcript)
**0.3.6**, retaining its MIT license in [LICENSE](LICENSE).

## Ownership

This directory owns activity grouping, workflow-source folding and image
visibility. Do not install it together with upstream
`@luan.sh/pi-collapse-transcript`; both would project the same transcript.

- Consecutive thinking/tool entries form one fold, with the upstream summary,
  elapsed time, step count, queue boundaries and compaction disclosure.
  Live work is open and folds once prose follows or the turn settles. A user
  toggle of that fold, observed between renders, disables the automatic close.
  Work interrupted by an error, abort or truncation (Pi's notice follows it, or
  the settle reports one) stays open until a later turn settles normally,
  including an automatic retry. Pi re-renders an interrupted message as new
  views, so work that first appears already stopped opens too, but only for
  the latest turn: restored history keeps its folds.
  libtui pins the viewport on every fold change; automatic changes restore
  Pi's follow-output state when it was following, so live output keeps
  scrolling. Manual clicks keep libtui's pinned viewport.
  Open live work renders the native components directly under the header:
  libtui's expanded surface repaints every row whenever streamed content
  changes, which made per-frame cost grow with the section (~26 ms for 800
  rows versus ~5 ms inline). Finished sections keep the surface.
- Top-level `<thinking>…</thinking>` text joins the thinking fold, including
  unfinished blocks while streaming. Backtick code spans (including multiline
  spans and partial streamed spans) and escaped tags do not end a thought.
  Code examples and unfinished final tags stay visible. Expansion retains the
  original tagged text.
- Interrupted native thinking forms its own fold while partial answers and native
  error, abort and truncation notices remain visible outside it. Restored
  history starts folded; the latest turn's interruption starts open (above).
- Top-level `js workflow` / `javascript workflow` fences join activity as tool
  preparation, including while streaming. Surrounding prose, ordinary code and
  nested code examples remain visible; incomplete final fences and native
  error/abort/truncation notices retain their original view.
- Native tool images appear below the folded row. Click an image, folded or
  expanded, to open it in the desktop image viewer for zooming and panning.
  The click does not change the fold; dragging and scrolling do not open images.
- `/images` previews tool images from the active branch, newest first. Up/down
  switches the actual picture; Enter opens it at full size and Escape cancels.
  The preview shows dimensions, time, the surrounding user request and a source
  filename when available. Identical image bytes share one entry with an
  occurrence count. It also works in regular mode, where the terminal owns mouse
  input.
- Expansion uses the original tool views inline (no fixed-height scroll box),
  with one copy of each image.
- Regular scrollback, model-visible messages and tool results are unchanged.

The group creates its image view once, alongside its existing activity view.
It queries libtui's public fold capability and renders the existing native
Image/spacer instances. There is no `setChildren` monkeypatch, separate image
widget, late-install retry, or second map of group identities.

## Dependency and compatibility

The package depends on **`@luan.sh/pi-libtui@0.3.15`**, pinned exactly: this is
the library version bundled with the fork's baseline, and some behavior relies on
details beyond its documented API (listed below). The package manifest loads
libtui's own extension from `node_modules`, as upstream does; it owns the native
transcript/history bridge, mouse/scrolling services and codemode presentation.
libtui's themes are not loaded.

If libtui is also installed as its own Pi package, both copies load. libtui
coordinates copies through versioned `globalThis` registries; keep both on the
same version, or filter one copy's extension out in `settings.json`.

Details beyond libtui's documented API that a libtui or Pi upgrade can break:

- `ToolViewRegion.setMode` pins the fullscreen viewport (`disableFollow`) on every
  fold change. Automatic folds restore following through Pi's fullscreen TUI
  `isFollowingOutput` / `scrollToBottom()`, which Pi does not document; without
  them, live output stops following after an automatic fold.
- Open live work places libtui's disclosure header (`ToolActivity.children[0]`)
  directly in the section instead of rendering `ToolActivity`.

Pi 1.3's native image selection is isolated in
[native-tool-images.ts](native-tool-images.ts). It borrows direct `Image` children
and their preceding `Spacer` from the native `Container`; it does not inspect
private image arrays or walk into tool-detail renderers. Other shapes produce no
extra preview; the expanded native view remains available. Native instances
continue to own image settings, IDs, conversion and invalidation.

`ToolImageActions` matches native Kitty/iTerm2 placement lines to the displayed
image bounds, including expanded viewports, without replacing native components.
Opening an image reads Pi 1.5's guarded `Image.base64Data` / `mimeType` fields;
there is no public source getter. [image-picker.ts](image-picker.ts) uses saved
tool-result blocks for `/images`, retaining the latest source/context for repeated
images. Its native `Image` preview is bounded to the terminal size and switches
without opening external applications until confirmation.
[image-viewer.ts](image-viewer.ts) writes those original bytes to a private OS
temporary directory and launches the desktop viewer (`open` on macOS,
`xdg-open` on Linux). It does not resize the file. Temporary files remain after
launch because desktop viewers may load them after the launcher exits.

Tagged thinking and workflow source selection are isolated in
[assistant-sources.ts](assistant-sources.ts).
It splits only libtui's single-text assistant views, reusing Pi's native rendering
with the original theme and padding. Whole-message Markdown transformers run
before splitting, with native width/streaming context, error handling and
invalidation. This includes Pi's built-in Mermaid transformer; fragments never
reapply those hooks. Possible reference definitions across prose spans retain
the complete Markdown context to preserve link resolution; their workflow source
stays visible. This boundary reads Pi 1.3's private assistant presentation fields;
unrecognized shapes stay native. Display views retain their identities through
streaming, resize and invalidation. The original messages, components and
workflow execution inputs are never rewritten. Plain JavaScript fences remain
ordinary content, including pi-subagents' untagged
fallback syntax; the explicit `workflow` tag selects this folding policy.

[interrupted-thinking.ts](interrupted-thinking.ts) handles the whole native
messages that libtui deliberately leaves unprojected on error, abort or length
stops. It splits their thinking from prose and reuses Pi's native notice renderer,
preserving its tool-call suppression rule. This is display-only: stored messages,
stop reasons and provider requests remain untouched.

## Baseline and maintenance

Copied upstream `src/activity-transcript.ts`, `activity-timing.ts` and
`compaction-section.ts`; upstream `src/extension.ts` is our `index.ts`.
The npm tarball integrity for 0.3.6 is:

```text
sha512-eeyRsMZ2McnDj7rmUGaNPiTv8UUOivjaGKcreDZZwFI+x5s0BlgXoCPC0vwI5NaDJVIdDj+lVcXZlLGZVvJPZA==
```

Keep changes against that baseline easy to inspect. Selectively port upstream
fixes rather than replacing this directory. The original tests are adapted under
`tests/fixtures/collapse-*.ts` to run with Node assertions inside the installed
Pi (`pi` must be on `PATH`), including standalone distributions.

From the repository root:

```sh
npm install
node --test tests/collapse-transcript.test.mjs
```

After a Pi/libtui upgrade, also check actual TUI history restoration, `/reload`,
image display, workflow source disclosure, mouse expansion and pi-vim.
Component-only tests do not establish extension startup ordering or terminal
protocol integration.
