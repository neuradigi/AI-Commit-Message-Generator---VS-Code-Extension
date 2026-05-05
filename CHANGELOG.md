# Change Log

All notable changes to **AI Git Commit Message Generator** are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] — 2026-05-05

### Changed
- **Repository, issues, and homepage URLs** now point at the public GitHub repo (`neuradigi/AI-Commit-Message-Generator---VS-Code-Extension`). The Marketplace listing's "Repository", "Issues", and "Homepage" links now resolve correctly.

## [1.3.0] — 2026-05-05

### Changed
- **Display name renamed to "AI Git Commit Message Generator"** — the previous name collided with another marketplace listing.
- **Generate from unstaged changes when nothing is staged.** The sparkle now mirrors `git commit` semantics: if any files are staged, the message is generated from the staged diff only; otherwise it falls back to the full working-tree diff. Previously the command failed with "No staged changes."

### Added
- **Sparkle button is disabled when there is nothing to commit.** A new context key (`neuradigiCommit.hasChanges`) tracks the repository's index + working-tree state, so the title-bar action is hidden when both are empty.

### Fixed
- **Stop button now appears in the same slot as the sparkle.** Both SCM title actions are pinned to `navigation@1`, so swapping between "generate" and "stop" no longer makes the button jump to a different position in the toolbar.

## [1.2.1] — 2026-05-05

### Fixed
- **Removed the `scm/inputBox` menu contribution.** This is a VS Code proposed API and is silently disabled in extensions installed from the Marketplace — only Microsoft's first-party extensions (like Copilot) get access. The runtime would log warnings ("scm/inputBox is a proposed menu identifier… requires enabledApiProposals") and the sparkle wouldn't actually render next to the commit input. The button is now contributed only to `scm/title` (the SCM panel title bar), which is a stable, public API.
- README updated to clarify where the sparkle appears.

## [1.2.0] — 2026-05-05

### Changed
- **Renamed to "AI Git Commit Message Generator"** to reflect that the extension now supports multiple engines (Claude CLI and Ollama). The publisher is unchanged (Neuradigi Technologies). Previously titled "Generate Commit Message using Claude".
- **New icon** — the Neuradigi brand mark, since the extension is no longer Claude-specific.
- Description updated to lead with the value (AI-generated Conventional Commits messages, your choice of engine, your data) instead of an implementation detail.

### Removed
- Build-time icon generation pipeline (`scripts/build-icon.js`, the `sharp` dev dependency, and `icon.svg`). Icon is now shipped directly as `icon.png`.

## [1.1.5] — 2026-05-05

### Added
- **Model availability check.** When switching to Ollama (or when auto-detect picks Ollama), the extension now checks not just that the Ollama server is running but also that the configured model is actually pulled. If the server is up but the model is missing, a modal appears with **Pull Model in Terminal** and **Change Model in Settings** buttons.
- The model check runs only on switch and on auto-detect (first generate). Subsequent generates skip the check to stay fast — if the model gets uninstalled later, the existing 404 error message at generate time still tells you exactly what to run.

## [1.1.4] — 2026-05-05

### Fixed
- The **Pull Model in Terminal** and **Verify in Terminal** buttons (shown when switching to a missing backend) now refresh PATH from the Windows registry inside the spawned PowerShell terminal before running the command. VS Code captures PATH at launch, so a terminal opened right after installing the Claude CLI or Ollama wouldn't find them — these buttons now handle that automatically without requiring a full VS Code restart.

## [1.1.3] — 2026-05-05

### Changed
- **Switch Backend now validates the choice.** If you pick Claude or Ollama and the chosen backend isn't actually installed/running, the extension shows a modal with step-by-step install instructions, an **Open Install Page** button (opens the official docs), and a shortcut button to verify the install or pull the Ollama model in a terminal. The current setting is left unchanged — no more silently-broken switches that error out at generate time.

## [1.1.2] — 2026-05-05

### Fixed
- **Claude CLI exited with `unknown option '---DIFF---'`.** When the long prompt was passed via `-p` on Windows with `shell: true`, the shell could leak prompt tokens into argv and the CLI parsed `---DIFF---` as a flag. The full instructions and the diff are now sent via stdin only; `-p` carries a short fixed prompt that has no dash-leading tokens. Also switched the diff fence markers from `---DIFF---` to `=== STAGED DIFF ===` to avoid any future shell-parsing ambiguity.

## [1.1.1] — 2026-05-05

### Fixed
- Removed the over-eager "no meaningful content" guard that rejected whitespace-only diffs. Whitespace-only changes are valid commits (e.g. `style: fix indentation`); the strict prompt and response sanitizer added in 1.0.1 already handle trivial diffs correctly.

## [1.1.0] — 2026-05-05

### Added
- **Ollama backend.** Generate commit messages locally and offline using Ollama — no Claude subscription required. Default model: `qwen2.5-coder:1.5b` (~1 GB on disk, runs on CPU).
- **Auto-detect on first use.** If you have one backend installed it's picked automatically. If both are installed, you're asked once and the choice is remembered. If neither is installed, a modal points you to install pages for both.
- **`Neuradigi Commit: Switch Backend` command** to change backends explicitly any time.
- New settings: `neuradigiCommit.backend` (`auto` / `claude` / `ollama`), `neuradigiCommit.ollamaUrl`, `neuradigiCommit.ollamaModel`.

### Changed
- Progress notification now names the active backend (e.g. "generating with ollama for myrepo…").

## [1.0.1] — 2026-05-05

### Fixed
- The CLI sometimes returned a chatty / conversational reply (e.g. "It looks like your message got cut off…") when the staged diff was tiny or whitespace-only, and that reply was written verbatim to the commit input box.
  - Default prompt tightened with stricter rules: output only, no questions, fall back to `chore: minor changes` for trivial diffs.
  - Diff is now wrapped in `---DIFF---` markers in the model input so it can't be confused with conversation.
  - Generation is rejected up-front if the staged diff has no meaningful added/removed content.
  - Response is post-processed to strip stray code fences, leading "Here's…" preambles, and surrounding quotes before being written to the commit box.

## [1.0.0] — 2026-05-05

Initial public release.

### Added
- Sparkle button in the Source Control input box and SCM panel title bar that generates a Conventional Commits message from the staged diff using the Claude CLI.
- Multi-repository workspace support — the message is written to the input box of the repository whose sparkle was clicked, identified via `SourceControl.rootUri`.
- Cancellable generation: while a request is in flight the sparkle becomes a stop button. Clicking it kills the underlying Claude process (full process tree on Windows via `taskkill /T /F`) and leaves the commit input box untouched.
- Per-repository job tracking — multiple repos can generate concurrently and each is independently cancellable.
- Configurable CLI path (`neuradigiCommit.cliPath`), prompt (`neuradigiCommit.prompt`), and extra CLI args (`neuradigiCommit.extraArgs`).
- Helpful error handling: Claude CLI not found, no staged changes, empty Claude response, non-zero CLI exit.
