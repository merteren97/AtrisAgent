export type DiffRow = { kind: 'add' | 'remove' | 'context'; text: string; before?: number; after?: number; hunk?: boolean };

export function textRows(before: string | null, after: string | null): DiffRow[] {
  const split = (text: string | null) => {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((line, index) => index < lines.length - 1 || text.endsWith('\n') ? line.replace(/\r$/, '') : line);
  };
  const left = split(before), right = split(after);
  let start = 0, endLeft = left.length, endRight = right.length;
  while (start < endLeft && start < endRight && left[start] === right[start]) start++;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
  const height = endLeft - start, width = endRight - start;
  const rows: DiffRow[] = [];
  for (let k = 0; k < start; k++) rows.push({ kind: 'context', text: left[k], before: k + 1, after: k + 1 });
  let i = 0, j = 0;
  const stride = width + 1;
  const lcs = (height + 1) * stride <= 1_500_000 && height && width ? new Uint32Array((height + 1) * stride) : null;
  if (lcs) for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    lcs[y * stride + x] = left[start + y] === right[start + x] ? 1 + lcs[(y + 1) * stride + x + 1] : Math.max(lcs[(y + 1) * stride + x], lcs[y * stride + x + 1]);
  }
  while (i < height || j < width) {
    if (lcs && i < height && j < width && left[start + i] === right[start + j]) rows.push({ kind: 'context', text: left[start + i], before: start + ++i, after: start + ++j });
    else if (i < height && (!lcs || j === width || lcs[(i + 1) * stride + j] >= lcs[i * stride + j + 1])) rows.push({ kind: 'remove', text: left[start + i], before: start + ++i });
    else rows.push({ kind: 'add', text: right[start + j], after: start + ++j });
  }
  for (let k = 0; endLeft + k < left.length; k++) rows.push({ kind: 'context', text: left[endLeft + k], before: endLeft + k + 1, after: endRight + k + 1 });
  return rows;
}

function headerPath(raw: string): string {
  let value = raw.split('\t')[0];
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes: number[] = [];
    const encoded = value.slice(1, -1);
    const encoder = new TextEncoder();
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '\\' && /^[0-7]{3}/.test(encoded.slice(i + 1))) { bytes.push(parseInt(encoded.slice(i + 1, i + 4), 8)); i += 3; }
      else if (encoded[i] === '\\' && i + 1 < encoded.length) bytes.push(...encoder.encode(({ t: '\t', r: '\r', n: '\n' } as Record<string, string>)[encoded[++i]] || encoded[i]));
      else bytes.push(...encoder.encode(encoded[i]));
    }
    value = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return value.replace(/^[ab]\//, '');
}

export function unifiedRows(diff: string): Map<string, DiffRow[]> {
  const result = new Map<string, DiffRow[]>();
  let rows: DiffRow[] | undefined, oldLine: number | undefined, newLine: number | undefined;
  let oldRemaining = 0, newRemaining = 0;
  const lines = diff.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!oldRemaining && !newRemaining && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const from = headerPath(line.slice(4)), to = headerPath(lines[++i].slice(4));
      const key = to === '/dev/null' ? from : to;
      rows = result.get(key) || [];
      result.set(key, rows);
      oldLine = undefined; newLine = undefined;
      continue;
    }
    if (line.startsWith('diff --git ')) { rows = undefined; oldRemaining = newRemaining = 0; continue; }
    if (!rows) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[3]);
      oldRemaining = Number(match[2] ?? 1); newRemaining = Number(match[4] ?? 1);
      rows.push({ kind: 'context', text: line, hunk: true });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), after: newLine });
      if (newLine !== undefined) { newLine++; newRemaining = Math.max(0, newRemaining - 1); }
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1), before: oldLine });
      if (oldLine !== undefined) { oldLine++; oldRemaining = Math.max(0, oldRemaining - 1); }
    } else if (line.startsWith(' ') && oldRemaining && newRemaining) {
      rows.push({ kind: 'context', text: line.slice(1), before: oldLine, after: newLine });
      oldLine = oldLine! + 1; newLine = newLine! + 1;
      oldRemaining--; newRemaining--;
    }
  }
  return result;
}
