import type { Application } from 'express';
import { findExecutable, launchInteractiveTerminal, runCommand } from '@atris-agent-code/runtime-host';
import fs from 'node:fs';
import path from 'node:path';

interface GithubCli {
  find: () => Promise<string | undefined>;
  account: (executable: string) => Promise<string>;
  login: (executable: string) => Promise<void>;
}

async function findGithubCli(): Promise<string | undefined> {
  const found = await findExecutable('gh');
  if (found) return found;
  if (process.platform !== 'win32') return undefined;
  const candidate = path.join(process.env.ProgramFiles || 'C:\\Program Files','GitHub CLI','gh.exe');
  try { return fs.statSync(candidate).isFile() ? candidate : undefined; } catch { return undefined; }
}

const githubCli: GithubCli = {
  find: findGithubCli,
  account: async executable => {
    const result = await runCommand(executable, ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { timeoutMs: 15_000, env: { GH_PROMPT_DISABLED: '1' }, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0 || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(result.stdout.trim())) throw new Error('GitHub account could not be verified.');
    return result.stdout.trim();
  },
  login: executable => launchInteractiveTerminal(executable, ['auth', 'login', '--hostname', 'github.com', '--web'], { title: 'GitHub sign in' }),
};

/** Keep the CLI-owned token in memory; callers must not serialize or log it. */
export async function readGithubCliToken(): Promise<string> {
  const executable = await findGithubCli();
  if (!executable) throw new Error('GitHub CLI is not installed.');
  try {
    const result = await runCommand(executable, ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 10_000, env: { GH_PROMPT_DISABLED: '1' }, maxOutputBytes: 16 * 1024 });
    const token = result.stdout.trim();
    if (result.exitCode !== 0 || !token || token.length > 4096 || /\s/.test(token)) throw new Error();
    return token;
  } catch { throw new Error('GitHub CLI authentication is unavailable. Sign in again.'); }
}

export function installGithubConnectionRoutes(app: Application, cli: GithubCli = githubCli): void {
  app.get('/api/integrations/github', async (_req, res) => {
    try {
      const executable = await cli.find();
      if (!executable) return res.json({ status: 'not_installed' });
      try { return res.json({ status: 'connected', username: await cli.account(executable) }); }
      catch { return res.json({ status: 'unverified' }); }
    } catch { return res.status(500).json({ error: 'Could not check GitHub CLI.' }); }
  });
  app.post('/api/integrations/github/login', async (_req, res) => {
    try {
      const executable = await cli.find();
      if (!executable) return res.status(400).json({ error: 'GitHub CLI is not installed or was not found in PATH.' });
      await cli.login(executable);
      return res.json({ started: true });
    } catch { return res.status(500).json({ error: 'Could not open GitHub CLI sign-in. Try again or run gh auth login in a terminal.' }); }
  });
}
