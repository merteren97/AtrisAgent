export type QualityResultRole = 'reviewer' | 'qa';

/** Required machine-readable Reviewer/QA result for the normal production path. */
export interface QualityResultEnvelope {
  type: 'quality_result';
  version: 1;
  role: QualityResultRole;
  verdict: 'pass' | 'fail';
  summary: string;
  findings?: string[];
  evidence?: string[];
}

/**
 * Parse a strict quality envelope from either a bare JSON value, a fenced
 * value, or prose containing one embedded JSON object. Non-quality JSON is
 * ignored so callers can retain their legacy prose fallback; malformed
 * quality-shaped JSON remains invalid and must fail closed.
 */
export function parseQualityResultEnvelope(rawResult: unknown): QualityResultEnvelope | null | 'invalid' {
  if (typeof rawResult !== 'string' && (typeof rawResult !== 'object' || rawResult === null)) return null;
  const candidates: unknown[] = [];
  let malformedQualityCandidate = false;
  if (typeof rawResult !== 'string') {
    candidates.push(rawResult);
  } else {
    const trimmed = rawResult.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const text = fenced?.[1] || trimmed;
    // Scan each object independently: quotes in surrounding prose must not
    // swallow the envelope's opening brace.
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '{') continue;
      const start = index;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let cursor = start; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end < 0) {
        if (/['"]type['"]\s*:\s*['"]quality_result['"]/i.test(text.slice(start))) malformedQualityCandidate = true;
        break;
      }
      const candidate = text.slice(start, end + 1);
      try { candidates.push(JSON.parse(candidate)); }
      catch {
        if (/['"]type['"]\s*:\s*['"]quality_result['"]/i.test(candidate)) malformedQualityCandidate = true;
      }
      index = end;
    }
  }
  let qualityEnvelopeCount = 0;
  let parsedEnvelope: QualityResultEnvelope | undefined;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const envelope = candidate as Partial<QualityResultEnvelope>;
    if (envelope.type !== 'quality_result') continue;
    qualityEnvelopeCount += 1;
    if (envelope.version !== 1
      || (envelope.role !== 'reviewer' && envelope.role !== 'qa')
      || (envelope.verdict !== 'pass' && envelope.verdict !== 'fail')
      || typeof envelope.summary !== 'string' || !envelope.summary.trim()
      || (envelope.findings !== undefined && (!Array.isArray(envelope.findings) || envelope.findings.some((item) => typeof item !== 'string')))
      || (envelope.evidence !== undefined && (!Array.isArray(envelope.evidence) || envelope.evidence.some((item) => typeof item !== 'string')))) {
      return 'invalid';
    }
    parsedEnvelope = envelope as QualityResultEnvelope;
  }
  if (qualityEnvelopeCount > 1 || malformedQualityCandidate) return 'invalid';
  return parsedEnvelope ?? null;
}

export interface PostApplyVerificationResult {
  passed: boolean;
  summary: string;
  evidence: string[];
}

export interface PostApplyVerificationContext {
  missionId: string;
  planId: string;
  runId?: string;
  builderTaskIds: string[];
}

export interface ApplyVerificationOperationContext extends PostApplyVerificationContext {
  operationId: string;
  idempotencyKey: string;
}

export interface ApplyVerificationOperationResult extends PostApplyVerificationResult {
  operationId: string;
  appliedTaskIds: string[];
}
