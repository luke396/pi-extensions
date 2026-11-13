# pi-extensions

Extensions for the [Pi](https://github.com/earendil-works/pi) coding agent.
Personal project, maintained on a best-effort basis. Tested with Pi 1.5.2.

| Extension | What it does |
|---|---|
| [collapse-transcript](extensions/collapse-transcript/README.md) | Groups consecutive thinking and tool calls into one fold. Work streams **open** while it runs and folds once the answer (or the next prose) arrives or the turn settles. Your own toggles are respected; errors and aborts stay open until a later turn completes normally. Fullscreen mode only. |
| [quiet-tui](extensions/quiet-tui.ts) | Turns off libtui's animated indicators and user-message bubbles, which kept a long fullscreen session repainting ~30 times a second. |
| [visible-paths](extensions/visible-paths/README.md) | Shows a readable path beside local Markdown links in assistant answers and thinking. Display only. |

collapse-transcript is a fork of
[`@luan.sh/pi-collapse-transcript`](https://github.com/luan/agents/tree/main/harnesses/pi/agent/packages/pi-collapse-transcript)
0.3.6 (MIT, Luan Santos) and builds on
[`@luan.sh/pi-libtui`](https://www.npmjs.com/package/@luan.sh/pi-libtui) 0.3.15.

## Install

```sh
pi install git:github.com/luke396/pi-extensions@v0.1.0
```

Pi clones the repository and installs its dependencies, including libtui, whose
extension the package loads from `node_modules`. Do not also install upstream
`@luan.sh/pi-collapse-transcript`.

To load only some extensions, use the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/luke396/pi-extensions@v0.1.0",
      "extensions": ["extensions/visible-paths/index.ts"]
    }
  ]
}
```

collapse-transcript needs libtui's extension
(`node_modules/@luan.sh/pi-libtui/src/extension.ts`); keep it selected unless libtui
is already installed as its own package at the same version.

## Development

```sh
npm install
npm test
```

The collapse-transcript tests run inside the installed Pi (`pi` on `PATH`),
without model calls. `.npmrc` keeps npm from installing Pi's own packages, which
Pi supplies at runtime.

## License

MIT. collapse-transcript retains its upstream MIT notice in
[extensions/collapse-transcript/LICENSE](extensions/collapse-transcript/LICENSE).
