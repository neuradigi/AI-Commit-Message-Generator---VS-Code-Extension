import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import type { API as GitAPI, GitExtension, Repository } from './git';

type Backend = 'claude' | 'ollama';

interface RunningJob {
  controller: AbortController;
  child?: ChildProcess;
  cancelled: boolean;
}

const jobs = new Map<string, RunningJob>();

const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

export async function activate(context: vscode.ExtensionContext) {
  await setGeneratingContext();
  await vscode.commands.executeCommand('setContext', 'neuradigiCommit.hasChanges', false);

  // Track repo change state so the SCM title button can be disabled when
  // there is nothing to commit. We watch every repository the Git extension
  // exposes and also any added later.
  void watchRepoChanges(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('neuradigiCommit.generate', async (arg?: unknown) => {
      try {
        await generate(arg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Neuradigi Commit: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('neuradigiCommit.cancel', async (arg?: unknown) => {
      try { await cancel(arg); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Neuradigi Commit: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('neuradigiCommit.switchBackend', async () => {
      await switchBackendCommand();
    })
  );
}

export function deactivate() {
  for (const job of jobs.values()) {
    job.cancelled = true;
    job.controller.abort();
    if (job.child) killTree(job.child);
  }
  jobs.clear();
}

async function setGeneratingContext() {
  await vscode.commands.executeCommand(
    'setContext',
    'neuradigiCommit.generating',
    jobs.size > 0
  );
}

async function watchRepoChanges(context: vscode.ExtensionContext) {
  let api: GitAPI;
  try {
    api = await getGitAPI();
  } catch {
    return; // Git extension unavailable; button just stays disabled.
  }

  const update = () => {
    const hasAny = api.repositories.some(
      r => r.state.indexChanges.length > 0 || r.state.workingTreeChanges.length > 0
    );
    void vscode.commands.executeCommand('setContext', 'neuradigiCommit.hasChanges', hasAny);
  };

  const watch = (repo: Repository) => {
    context.subscriptions.push(repo.state.onDidChange(update));
  };

  api.repositories.forEach(watch);
  context.subscriptions.push(api.onDidOpenRepository(repo => { watch(repo); update(); }));
  context.subscriptions.push(api.onDidCloseRepository(update));
  update();
}

async function getGitAPI(): Promise<GitAPI> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) throw new Error('Built-in Git extension (vscode.git) not found.');
  const gitExt = ext.isActive ? ext.exports : await ext.activate();
  if (!gitExt.enabled) throw new Error('The Git extension is disabled.');
  return gitExt.getAPI(1);
}

async function pickRepository(api: GitAPI, arg: unknown): Promise<Repository> {
  const repos = api.repositories;
  if (repos.length === 0) throw new Error('No Git repositories in this workspace.');

  const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (rootUri) {
    const match = repos.find(r => r.rootUri.toString() === rootUri.toString());
    if (match) return match;
    throw new Error(`Could not locate repository for ${rootUri.fsPath}.`);
  }

  if (repos.length === 1) return repos[0];

  const pick = await vscode.window.showQuickPick(
    repos.map(r => ({ label: vscode.workspace.asRelativePath(r.rootUri), repo: r })),
    { placeHolder: 'Select a repository' }
  );
  if (!pick) throw new Error('No repository selected.');
  return pick.repo;
}

async function generate(arg: unknown) {
  const api = await getGitAPI();
  const repo = await pickRepository(api, arg);
  const key = repo.rootUri.toString();

  if (jobs.has(key)) throw new Error('Already generating for this repository.');

  // Mirror `git commit` semantics: if anything is staged, use the staged diff;
  // otherwise fall back to the full working-tree diff so users can generate a
  // message without explicitly staging first.
  const hasStaged = repo.state.indexChanges.length > 0;
  const hasUnstaged = repo.state.workingTreeChanges.length > 0;
  if (!hasStaged && !hasUnstaged) {
    throw new Error('No changes to commit.');
  }

  const useStaged = hasStaged;
  const diff = await repo.diff(useStaged);
  if (!diff || diff.trim().length === 0) {
    throw new Error(useStaged ? 'Staged diff is empty.' : 'Working-tree diff is empty.');
  }

  const backend = await resolveBackend();
  if (!backend) return; // user cancelled or chose to install something

  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const prompt = config.get<string>('prompt', '');

  const job: RunningJob = { controller: new AbortController(), cancelled: false };
  jobs.set(key, job);
  await setGeneratingContext();

  let result: { stdout: string; cancelled: boolean };
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Neuradigi Commit: generating with ${backend} for ${vscode.workspace.asRelativePath(repo.rootUri)}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        token.onCancellationRequested(() => abort(key));
        if (backend === 'claude') {
          return runClaude(key, repo.rootUri.fsPath, prompt, diff);
        }
        return runOllama(key, prompt, diff);
      }
    );
  } finally {
    jobs.delete(key);
    await setGeneratingContext();
  }

  if (result.cancelled) return;
  const cleaned = sanitizeCommitMessage(result.stdout);
  if (!cleaned) throw new Error(`${backend} returned an empty response.`);
  repo.inputBox.value = cleaned;
}

async function cancel(arg: unknown) {
  const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (rootUri) {
    abort(rootUri.toString());
    return;
  }
  const keys = [...jobs.keys()];
  if (keys.length === 0) return;
  if (keys.length === 1) { abort(keys[0]); return; }
  const pick = await vscode.window.showQuickPick(
    keys.map(k => ({ label: vscode.workspace.asRelativePath(vscode.Uri.parse(k)), key: k })),
    { placeHolder: 'Cancel which generation?' }
  );
  if (pick) abort(pick.key);
}

function abort(key: string) {
  const job = jobs.get(key);
  if (!job) return;
  job.cancelled = true;
  jobs.delete(key);
  void setGeneratingContext();
  job.controller.abort();
  if (job.child) killTree(job.child);
}

// --- Backend resolution -----------------------------------------------------

async function resolveBackend(): Promise<Backend | null> {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const setting = config.get<string>('backend', 'auto');
  if (setting === 'claude' || setting === 'ollama') return setting;

  const [claudeOk, ollamaOk] = await Promise.all([detectClaude(), detectOllama()]);

  if (claudeOk && ollamaOk) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(sparkle) Claude CLI',
          description: 'Cloud — best quality (uses your Claude account)',
          backend: 'claude' as Backend,
        },
        {
          label: '$(server) Ollama',
          description: 'Local — free, offline, runs on your machine',
          backend: 'ollama' as Backend,
        },
      ],
      { placeHolder: 'Choose a backend (you can change this later in settings)' }
    );
    if (!pick) return null;
    if (pick.backend === 'ollama') {
      const model = config.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
      if (!(await detectOllamaModel(model))) {
        await offerPullModel(model);
        return null;
      }
    }
    await config.update('backend', pick.backend, vscode.ConfigurationTarget.Global);
    return pick.backend;
  }

  if (claudeOk) {
    await config.update('backend', 'claude', vscode.ConfigurationTarget.Global);
    return 'claude';
  }
  if (ollamaOk) {
    const model = config.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
    if (!(await detectOllamaModel(model))) {
      await offerPullModel(model);
      return null;
    }
    await config.update('backend', 'ollama', vscode.ConfigurationTarget.Global);
    return 'ollama';
  }

  // Neither installed — guide the user.
  const choice = await vscode.window.showErrorMessage(
    'Neuradigi Commit: no backend detected. Install one to generate commit messages.',
    { modal: true, detail: 'Claude CLI (cloud, best quality) or Ollama (local, free, offline).' },
    'Install Claude CLI',
    'Install Ollama'
  );
  if (choice === 'Install Claude CLI') {
    vscode.env.openExternal(vscode.Uri.parse(CLAUDE_INSTALL_URL));
  } else if (choice === 'Install Ollama') {
    vscode.env.openExternal(vscode.Uri.parse(OLLAMA_INSTALL_URL));
  }
  return null;
}

async function switchBackendCommand() {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const current = config.get<string>('backend', 'auto');
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Auto-detect', description: 'Pick whichever is installed; ask once if both are available', value: 'auto' },
      { label: 'Claude CLI', description: 'Cloud — best quality', value: 'claude' },
      { label: 'Ollama', description: 'Local — free, offline', value: 'ollama' },
    ].map(o => o.value === current ? { ...o, label: `$(check) ${o.label}` } : o),
    { placeHolder: 'Select the backend to use' }
  );
  if (!pick) return;

  // For an explicit backend choice, verify it's actually available before
  // saving. If it isn't, show actionable install instructions and don't
  // overwrite the existing setting — the user almost certainly didn't mean
  // to switch to something that won't work.
  if (pick.value === 'claude') {
    if (!(await detectClaude())) {
      await offerInstall('claude');
      return;
    }
  } else if (pick.value === 'ollama') {
    if (!(await detectOllama())) {
      await offerInstall('ollama');
      return;
    }
    const model = config.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
    if (!(await detectOllamaModel(model))) {
      await offerPullModel(model);
      return;
    }
  }

  await config.update('backend', pick.value, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Neuradigi Commit: backend set to "${pick.value}".`);
}

async function offerInstall(backend: Backend) {
  if (backend === 'claude') {
    const choice = await vscode.window.showWarningMessage(
      'Claude CLI is not installed (or not on your PATH).',
      {
        modal: true,
        detail:
          'Backend not switched. To use the Claude backend:\n\n' +
          '1. Install the Claude Code CLI from the link below.\n' +
          '2. Run "claude login" in a terminal and finish the sign-in.\n' +
          '3. Verify with "claude --version".\n' +
          '4. Run "Neuradigi Commit: Switch Backend" again and pick Claude CLI.',
      },
      'Open Install Page',
      'Verify in Terminal'
    );
    if (choice === 'Open Install Page') {
      vscode.env.openExternal(vscode.Uri.parse(CLAUDE_INSTALL_URL));
    } else if (choice === 'Verify in Terminal') {
      runInRefreshedTerminal('Claude CLI check', 'claude --version');
    }
    return;
  }

  // ollama
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const url = config.get<string>('ollamaUrl', 'http://localhost:11434');
  const model = config.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
  const choice = await vscode.window.showWarningMessage(
    `Ollama is not running at ${url}.`,
    {
      modal: true,
      detail:
        'Backend not switched. To use the Ollama backend:\n\n' +
        '1. Install Ollama from the link below (Windows/macOS/Linux).\n' +
        '2. After install, the Ollama service starts automatically. If not, run "ollama serve" or launch the Ollama app.\n' +
        `3. Pull the model once: ollama pull ${model}\n` +
        '4. Run "Neuradigi Commit: Switch Backend" again and pick Ollama.',
    },
    'Open Install Page',
    'Pull Model in Terminal'
  );
  if (choice === 'Open Install Page') {
    vscode.env.openExternal(vscode.Uri.parse(OLLAMA_INSTALL_URL));
  } else if (choice === 'Pull Model in Terminal') {
    runInRefreshedTerminal('Ollama setup', `ollama pull ${model}`);
  }
}

// VS Code captures PATH when it launches, so terminals opened after a fresh
// install of a CLI tool don't see the new entry. On Windows we force a
// PowerShell terminal and re-read PATH from the registry into the session
// before running the command, so the just-installed CLI is found.
function runInRefreshedTerminal(name: string, command: string) {
  const isWin = process.platform === 'win32';
  const term = vscode.window.createTerminal(
    isWin
      ? { name, shellPath: 'powershell.exe' }
      : { name }
  );
  term.show();
  if (isWin) {
    term.sendText(
      '$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")'
    );
  }
  term.sendText(command);
}

async function detectClaude(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const cliPath = config.get<string>('cliPath', 'claude');
  return new Promise(resolve => {
    let resolved = false;
    const done = (v: boolean) => { if (!resolved) { resolved = true; resolve(v); } };
    let p: ChildProcess;
    try {
      p = spawn(cliPath, ['--version'], {
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      done(false); return;
    }
    p.on('error', () => done(false));
    p.on('close', code => done(code === 0));
    setTimeout(() => { if (!resolved) { try { p.kill(); } catch { /* ignore */ } done(false); } }, 3000);
  });
}

async function detectOllama(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const url = config.get<string>('ollamaUrl', 'http://localhost:11434');
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function detectOllamaModel(model: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const url = config.get<string>('ollamaUrl', 'http://localhost:11434');
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json() as { models?: { name: string }[] };
    const installed = (data.models ?? []).map(m => m.name);
    // Ollama's tag list includes the explicit tag (e.g. "qwen2.5-coder:1.5b").
    // A bare model name like "qwen2.5-coder" matches the ":latest" tag.
    return installed.some(name =>
      name === model ||
      name === `${model}:latest` ||
      (model.includes(':') ? false : name.startsWith(`${model}:`))
    );
  } catch {
    return false;
  }
}

async function offerPullModel(model: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Ollama is running, but the model "${model}" is not pulled.`,
    {
      modal: true,
      detail:
        `To use the Ollama backend you need to pull the configured model.\n\n` +
        `1. Open a terminal (the button below opens one with PATH refreshed).\n` +
        `2. Run: ollama pull ${model}\n` +
        `3. Wait for the download to finish.\n` +
        `4. Try again — the extension will pick up the model automatically.`,
    },
    'Pull Model in Terminal',
    'Change Model in Settings'
  );
  if (choice === 'Pull Model in Terminal') {
    runInRefreshedTerminal('Ollama setup', `ollama pull ${model}`);
  } else if (choice === 'Change Model in Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'neuradigiCommit.ollamaModel');
  }
  return false;
}

// --- Backend runners --------------------------------------------------------

interface BackendResult { stdout: string; cancelled: boolean; }

function runClaude(
  key: string,
  cwd: string,
  prompt: string,
  diff: string
): Promise<BackendResult> {
  return new Promise((resolve, reject) => {
    const config = vscode.workspace.getConfiguration('neuradigiCommit');
    const cliPath = config.get<string>('cliPath', 'claude');
    const extraArgs = config.get<string[]>('extraArgs', []);
    // Keep the -p argument short and free of dash-leading tokens. With
    // shell: true on Windows, long prompts can leak tokens into argv and the
    // CLI then mis-parses things like "---DIFF---" as flags. The full
    // instructions and the diff are sent via stdin instead.
    const args = ['-p', 'Read the instructions and staged diff from stdin and produce the requested output.', ...extraArgs];
    const stdinPayload = `${prompt}\n\n=== GIT DIFF ===\n${diff}\n=== END OF DIFF ===\n`;

    let child: ChildProcess;
    try {
      child = spawn(cliPath, args, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`Failed to launch Claude CLI (${cliPath}): ${(err as Error).message}`));
      return;
    }

    const job = jobs.get(key);
    if (job) job.child = child;

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const j = jobs.get(key);
      if (j?.cancelled) { resolve({ stdout: '', cancelled: true }); return; }
      if (err.code === 'ENOENT') {
        reject(new Error(`Claude CLI not found at "${cliPath}". Install it or set neuradigiCommit.cliPath.`));
      } else {
        reject(new Error(`Failed to launch Claude CLI: ${err.message}`));
      }
    });

    child.on('close', code => {
      const j = jobs.get(key);
      if (j?.cancelled) { resolve({ stdout: '', cancelled: true }); return; }
      if (code === 0) {
        resolve({ stdout, cancelled: false });
      } else {
        const detail = stderr.trim() || stdout.trim() || '(no output)';
        reject(new Error(`Claude CLI exited with code ${code}: ${detail}`));
      }
    });

    child.stdin?.end(stdinPayload);
  });
}

async function runOllama(
  key: string,
  prompt: string,
  diff: string
): Promise<BackendResult> {
  const config = vscode.workspace.getConfiguration('neuradigiCommit');
  const url = config.get<string>('ollamaUrl', 'http://localhost:11434');
  const model = config.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
  const job = jobs.get(key);
  const signal = job?.controller.signal;

  const fullPrompt = `${prompt}\n\n=== GIT DIFF ===\n${diff}\n=== END OF DIFF ===\n`;

  let res: Response;
  try {
    res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: fullPrompt, stream: false }),
      signal,
    });
  } catch (err) {
    if (job?.cancelled || (err as Error).name === 'AbortError') {
      return { stdout: '', cancelled: true };
    }
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      throw new Error(`Could not reach Ollama at ${url}. Start Ollama (run \`ollama serve\` or launch the Ollama app) and try again.`);
    }
    throw new Error(`Ollama request failed: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 && body.includes('not found')) {
      throw new Error(`Ollama model "${model}" is not installed. Run \`ollama pull ${model}\` and try again.`);
    }
    throw new Error(`Ollama returned ${res.status}: ${body || res.statusText}`);
  }

  const data = await res.json() as { response?: string; error?: string };
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  return { stdout: data.response ?? '', cancelled: false };
}

// --- Helpers ----------------------------------------------------------------

function sanitizeCommitMessage(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(here(?:'s| is)|sure|okay|ok)[^\n]*:\s*\n+/i, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch { /* ignore */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 1000);
  }
}
