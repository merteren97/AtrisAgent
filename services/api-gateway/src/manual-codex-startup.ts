import { createHash } from 'node:crypto';

const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'PostToolUse'];

/** Codex 0.166 hook identity: sorted JSON of the normalized TOML declaration.
 * Trust only the handlers we generate, never inherited user/project/plugin hooks.
 */
export function codexManualProfile(profilePath: string, cwd: string, command: string, commandWindows: string): string {
  const effectiveCommand = process.platform === 'win32' ? commandWindows : command;
  const declarations = events.map(event => {
    const eventKey = event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`);
    // TOML omits None fields; version_for_toml recursively sorts object keys.
    const identity = JSON.stringify({event_name:eventKey, hooks:[{async:false, command:effectiveCommand, timeout:5, type:'command'}]});
    const hash = 'sha256:' + createHash('sha256').update(identity).digest('hex');
    return `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ncommand_windows = ${JSON.stringify(commandWindows)}\ntimeout = 5\n\n[hooks.state.${JSON.stringify(`${profilePath}:${eventKey}:0:0`)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`;
  }).join('');
  // This launch was requested for this exact workspace. Do not trust its parent
  // repository, other folders, or persist a trust decision in config.toml.
  return '# AtrisAgent managed manual session bridge v1\n' +
    `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n` + declarations;
}
