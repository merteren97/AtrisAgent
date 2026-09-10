/** Local, deterministic titles: no model request, transcript upload or extra latency. */
export function manualContentTitle(text: string): string | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const value = line
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
      .replace(/(?<!\w)([*_])(.+?)\1(?!\w)/g, '$2').replace(/\s+/g, ' ').trim();
    if (!value || /^[/<]/.test(value) || !/[\p{L}\p{N}]/u.test(value)) continue;
    if (/^(?:merhaba|selam|selamlar|günaydın|iyi günler|hi|hello|hey|thanks|thank you|teşekkürler|tamam|ok|okay|evet|yes|devam|continue)[\s!.?…]*$/iu.test(value)) continue;
    const characters = Array.from(value);
    if (characters.length <= 64) return value;
    const prefix = characters.slice(0, 61).join('');
    const boundary = prefix.lastIndexOf(' ');
    return `${boundary >= 40 ? prefix.slice(0, boundary) : prefix}…`;
  }
  return undefined;
}

export function manualProviderName(runtime: string): string {
  return ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' } as Record<string, string>)[runtime] || 'Agent';
}
