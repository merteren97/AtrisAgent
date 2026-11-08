import { runCommand } from '@atris-agent-code/runtime-host';

const incompatible = (message: string) => Object.assign(new Error(message), {status:400});

/** Check required CLI features before creating any managed profile or runtime.
 * Version numbers are informational, never a launch gate. The owning session
 * verifies actual protocol responses and effective permissions independently.
 */
export async function verifyManualCodexCompatibility(executable: string, command = runCommand, platform = process.platform): Promise<void> {
  if (platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) {
    throw incompatible('Live Codex sessions require the native Codex executable. Reconnect the Codex installation in Accounts.');
  }
  const probe = async (args: string[]) => {
    try {
      const result = await command(executable, args, {timeoutMs:5000});
      if (result.exitCode !== 0) throw new Error('Probe failed');
      return result.stdout;
    } catch {
      throw incompatible(`Could not verify Codex CLI ${args.join(' ')}. Reconnect the Codex installation in Accounts and retry.`);
    }
  };
  const help = await probe(['--help']);
  if (!/--profile\b/.test(help) || !help.includes('.config.toml')) {
    throw incompatible('This Codex installation does not expose the layered CLI profiles required for manual Chat/Code sessions.');
  }
  if (!['--remote', '--remote-auth-token-env', '--cd'].every(flag => new RegExp(`${flag}(?:\\s|=|$)`).test(help))) {
    throw incompatible('This Codex installation does not expose the remote terminal options required for live permissions. Reconnect a supported Codex CLI installation in Accounts.');
  }
  const serverHelp = await probe(['app-server', '--help']);
  if (!/--stdio(?:\s|$)/.test(serverHelp)) {
    throw incompatible('This Codex installation does not expose app-server --stdio required for live permissions. Reconnect a supported Codex CLI installation in Accounts.');
  }
}
