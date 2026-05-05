# AI Git Commit Message Generator

Click a sparkle next to your Source Control commit box → get a Conventional Commits message generated from your staged diff → review, tweak, commit.

Works with **two engines** — pick whichever fits:

- **Claude CLI** — cloud, best quality, uses your Claude account.
- **Ollama** — local, free, offline. Runs on your machine. No subscription, no data leaves your computer.

The extension auto-detects what you have installed. If both are present, it asks once and remembers your choice. You can switch any time.

## Features

- **Sparkle button in the Source Control panel title bar.** One click, no command palette dance. (Also available from the palette as "Generate Commit Message".)
- **Two engines, one extension.** Cloud (Claude) or local (Ollama) — your call.
- **Cancellable.** While generating, the sparkle turns into a stop button — click it to kill the request immediately. The commit input box is left untouched on cancel.
- **Multi-repo aware.** Built on the official `vscode.git` extension API; the clicked repo is identified by `SourceControl.rootUri` and never falls back to "repository zero".
- **Helpful onboarding.** If a chosen engine isn't installed/running — or if Ollama is up but the configured model isn't pulled — a modal shows step-by-step install instructions and one-click buttons to open the official install page or run the right command in a PATH-refreshed terminal.
- **Configurable prompt and model.**
- **Honest errors.** No staged changes? Tells you. Engine missing? Tells you. Ollama model not pulled? Tells you exactly what to run.

## Requirements

- VS Code **1.80** or later.
- A Git repository (the built-in `vscode.git` extension must be enabled).
- **At least one engine** installed (you can install both):
  - **Claude CLI**: install via https://docs.claude.com/en/docs/claude-code/setup, then `claude login`.
  - **Ollama**: install via https://ollama.com/download, then `ollama pull qwen2.5-coder:1.5b` (or any other model — see "Ollama models" below).

## Usage

1. Stage the changes you want included in the commit message.
2. Open the **Source Control** view (`Ctrl+Shift+G`).
3. Click the **sparkle** icon in the panel title bar (top of the Source Control view, near the `…` overflow). Or run **"Generate Commit Message"** from the command palette.
4. On first use the extension picks an engine (or asks if both are installed). Subsequent clicks skip this and use the saved choice.
5. Wait for the progress notification — or click the **stop** icon to cancel.
6. The generated message lands in the input box. Edit if needed and commit.

To change engines later: `Ctrl+Shift+P` → **"Neuradigi Commit: Switch Backend"**, or edit `neuradigiCommit.backend` in settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `neuradigiCommit.backend` | `auto` | `auto` / `claude` / `ollama`. `auto` picks whichever is installed; if both, asks once and saves. |
| `neuradigiCommit.cliPath` | `claude` | Path to the Claude CLI executable. |
| `neuradigiCommit.ollamaUrl` | `http://localhost:11434` | Base URL of the Ollama HTTP server. |
| `neuradigiCommit.ollamaModel` | `qwen2.5-coder:1.5b` | Ollama model to use. Pull it first with `ollama pull <model>`. |
| `neuradigiCommit.prompt` | (Conventional Commits prompt) | Prompt sent to the engine. |
| `neuradigiCommit.extraArgs` | `[]` | Extra args for the Claude CLI (ignored for Ollama). |

## Ollama models

Recommended choices for commit-message generation, ordered by quality vs. resource cost:

| Model | Size | RAM | Speed | Notes |
| --- | --- | --- | --- | --- |
| `qwen2.5-coder:1.5b` | ~1 GB | 2–3 GB | Fast (CPU OK) | Good default — small enough for any modern machine. |
| `qwen2.5-coder:7b` | ~4.5 GB | 8 GB | Medium | Notably better commit messages; ideal if you have the RAM. |
| `llama3.2:3b` | ~2 GB | 4 GB | Fast | General-purpose alternative if you already have it. |

Pull a model once: `ollama pull qwen2.5-coder:1.5b`. Then set `neuradigiCommit.ollamaModel` accordingly.

## Privacy

- **Claude engine**: your staged diff is sent to Claude via the official CLI. See https://docs.claude.com/en/docs/claude-code/security.
- **Ollama engine**: your diff stays on your machine. The extension only talks to `localhost:11434` (or whatever `ollamaUrl` you set). No external network calls.

The extension itself sends no telemetry to anyone.

## Known limitations

- VS Code menu `when` clauses are global, so if a generation is running in repo A while repo B's SCM is also visible, repo B's sparkle also displays as a stop icon. Clicking stop only cancels A. Cosmetic only.
- Very large staged diffs may exceed the model's context window — stage in smaller chunks.
- First Ollama call after starting Ollama can be slower while the model loads into RAM. Subsequent calls are fast.

## Changelog

See the **Changelog** tab on the Marketplace listing.

## License

MIT.
