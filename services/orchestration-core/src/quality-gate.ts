import { redactSensitiveValue } from '@atris-agent-code/event-bus';
import type { TaskSelect } from '@atris-agent-code/database';
import {
  parseQualityResultEnvelope,
  type QualityResultEnvelope,
} from '@atris-agent-code/domain';

export { parseQualityResultEnvelope, type QualityResultEnvelope };

export const MAX_QUALITY_SUMMARY_CHARS = 4_000;

export interface QualityVerdict {
  passed: boolean;
  summary: string;
  findingCount: number;
  reason: 'approved' | 'failed' | 'ambiguous';
}

export function clearNegatedQualitySignals(text: string): string {
  return text
    // Remove ordinary negated failure lists before scanning individual words;
    // e.g. "no test failures or errors" or "no pending issues" is a passing report, not a failure.
    .replace(/\b(?:0|no|without|zero|none)\s+(?:(?:any|all|the|pending|open|remaining|unresolved|test|tests|check|checks|build|builds|lint|validation|validations|blocking|major|critical)\s+)*(?:failures?|errors?|issues?|defects?|problems?|concerns?|blockers?|work|items?|tasks?)(?:\s+(?:and|or)\s+(?:failures?|errors?|issues?|defects?|problems?|concerns?|blockers?))*/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:any\s+)?(?:blocking|major|critical)(?:(?:[,/]\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)(?:blocking|major|critical))*\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\b/gi, ' ')
    .replace(/\b(?:0|no|without|zero)\s+(?:failed|failing)\s+(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\b/gi, ' ')
    .replace(/\b(?:0|no|without|zero)\s+(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\s+(?:failed|failing)\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:revision|revisions|change|changes)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:requested|required|needed)\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:(?:test|tests|check|checks|build|builds|command|commands|lint|validation|validations)\s+)?(?:failures?|errors?)(?:\s+(?:or|and|[/,])\s+(?:failures?|errors?))?\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:blocking|blocked|blockers?|major|critical|failure|failures|error|errors|pending)\b/gi, ' ')
    .replace(/\b(?:0|none)\s+(?:blocking|major|critical)(?:(?:[,/]\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)(?:blocking|major|critical))*\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\b/gi, ' ')
    .replace(/\b(?:blocking|major|critical)\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\s*(?:[:=(]\s*)?(?:0|none)\b/gi, ' ')
    .replace(/\b(?:0|none)\s+(?:failed|failing|failure|failures|error|errors|issues?|pending)\b/gi, ' ')
    .replace(/\b(?:blocking|major|critical)\s*[:=-]\s*(?:none|no)\b/gi, ' ');
}

export function hasQualityFailureSignal(text: string, allowResolvedFindings = true): boolean {
  const evaluableText = clearNegatedQualitySignals(text)
    // Preserve the rest of each sentence so a later failed check still rejects the pass,
    // while allowing completed-repair statements ("fixed the error") without unresolved modals.
    .replace(/[^.!?\n]+/g, (sentence) => {
      if (
        !allowResolvedFindings
        || !/(?:^\s*|[:\-–—]\s*|,\s*|\band\s+)(?:fixed|resolved|corrected|eliminated|sanitized)\b/i.test(sentence)
        || /\b(?:not|never|unable|cannot|can't|pending|unresolved|still|should|must|needs?|required)\b/i.test(sentence)
      ) {
        return sentence;
      }
      return sentence
        .replace(/\b(?:fixed|resolved|corrected|eliminated)\s+(?:(?:the|a|an|reported|previous|existing|seed|script|syntax|type|runtime|foreign|key|test|build|lint)\s+)*(?:errors?|failures?|defects?|issues?|bugs?)\b/gi, 'resolved finding')
        .replace(/\bto prevent\s+(?:(?:the|a|an|foreign|key|runtime|syntax|type|validation|InvalidDate|NaN|and)\s+)*(?:errors?|failures?)\b/gi, 'preventive fix');
    });

  return [
    /\b(?:revision|revisions|change|changes)\s+(?:is\s+|are\s+)?(?:requested|required|needed)\b/i,
    /\brequest(?:ed)?\s+(?:a\s+)?(?:revision|revisions|change|changes)\b/i,
    /\b(?:cannot|can't|can not|unable to|not enough evidence to|not able to)\s+(?:recommend\s+)?(?:approve|approval|pass|passing)\b/i,
    /\b(?:not|never)\s+(?:approve|approved|approval|pass|passed|passing)\b/i,
    /\b(?:approval|verdict|recommendation)\s*[:=-]?\s*(?:pending|unclear|unknown|none|not available)\b/i,
    /\b(?:no|without|zero)\s+pass(?:ed|es|ing)?\s+(?:was\s+)?(?:reported|provided|given|verdict|result|recommendation)\b/i,
    /\b(?:pass|approval|verdict)\s*[:=-]\s*(?:no|false|fail(?:ed)?|rejected|blocked|pending)\b/i,
    /\b(?:reject(?:ed|s|ion)?|denied|declined|unapproved)\b/i,
    /\b(?:fail(?:ed|s|ure|ures|ing)?)\b/i,
    /\berrors?\b/i,
    /\b(?:did not|didn't|does not|doesn't|not)\s+pass(?:ed|es|ing)?\b/i,
    /\b(?:no|none of the|zero)\s+(?:(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\s+)?pass(?:ed|es|ing)?\b/i,
    /\b(?:blocked|blocking|blockers?)\b/i,
    /\b(?:major|critical)\s+(?:finding|findings|issue|issues|defect|defects|problem|problems|concern|concerns|severity)\b/i,
    /\b(?:finding|findings|issue|issues|defect|defects|problem|problems|concern|concerns)\s+(?:with\s+)?(?:major|critical)\b/i,
    /\bseverity\s*[:=-]?\s*(?:major|critical)\b/i,
    /\b(?:unclear|ambiguous|unknown|indeterminate|inconclusive|pending)\b/i,
    /\b(?:insufficient|not enough)\s+(?:evidence|information)\b/i,
    /\b(?:pass|passed|approve|approved)\s*[?/]\b/i,
    /\bpass\s*(?:\/|or)\s*fail\b/i,
  ].some((pattern) => pattern.test(evaluableText));
}

export function inferQualityVerdict(
  role: TaskSelect['assignedRole'],
  rawResult: unknown,
): QualityVerdict | null {
  if (role !== 'reviewer' && role !== 'qa') return null;

  const envelope = parseQualityResultEnvelope(rawResult);
  if (envelope === 'invalid' || (envelope && envelope.role !== role)) {
    return {
      passed: false,
      summary: 'Invalid or mismatched structured quality result.',
      findingCount: 1,
      reason: 'ambiguous',
    };
  }
  if (envelope) {
    const detail = [envelope.summary, ...(envelope.findings || []), ...(envelope.evidence || [])].join('\n');
    // Evidence is supporting material and commonly contains path names such
    // as `error-boundary.tsx` or raw command output. Only the summary/findings
    // express the quality judgment; scanning evidence creates false failures
    // for an otherwise explicit structured pass.
    const judgment = [envelope.summary, ...(envelope.findings || [])].join('\n');
    const contradictory = envelope.verdict === 'pass' && hasQualityFailureSignal(judgment, true);
    const passed = envelope.verdict === 'pass' && !contradictory;
    const failureDetails = [envelope.summary, ...(envelope.findings || [])].filter((text) => hasQualityFailureSignal(text, true));
    const resultSummary = contradictory
      ? `Quality approval was not accepted: the agent reported pass but also reported a failed check or unresolved issue. ${failureDetails.join('\n')}\nResolve the reported issue and rerun the quality gate before applying changes.\n\n${detail}`
      : detail;
    return {
      passed,
      summary: String(redactSensitiveValue(resultSummary)).slice(0, MAX_QUALITY_SUMMARY_CHARS),
      findingCount: passed ? 0 : Math.max(1, envelope.findings?.length || 0),
      reason: passed ? 'approved' : contradictory ? 'ambiguous' : 'failed',
    };
  }

  const rawText = typeof rawResult === 'string' ? rawResult.trim() : '';
  const safeResult = rawText ? String(redactSensitiveValue(rawText)).slice(0, MAX_QUALITY_SUMMARY_CHARS) : '';
  const hasFailure = hasQualityFailureSignal(rawText, true);
  const hasNegatedExplicitPass = /\b(?:no|without|zero)\s+explicit\s+(?:approve|approval|pass|verdict)\b/i.test(rawText);
  const hasExplicitPass = !hasNegatedExplicitPass && (
    /\b(?:approve|approved|approves|pass|passed|passes|passing)\b/i.test(rawText)
    || /\bapproval\s*(?:status\s*)?[:=-]\s*(?:yes|true|granted|approved)\b/i.test(rawText)
  );
  const passed = !hasFailure && hasExplicitPass;
  const reason: QualityVerdict['reason'] = passed ? 'approved' : hasFailure ? 'failed' : 'ambiguous';
  const summary = `[legacy_compatibility_fallback] ${safeResult || (role === 'reviewer'
    ? 'No explicit review approval or revision verdict was reported.'
    : 'No explicit QA pass or failure verdict was reported.')}`.slice(0, MAX_QUALITY_SUMMARY_CHARS);

  return {
    passed,
    summary,
    findingCount: passed || !rawText ? 0 : 1,
    reason,
  };
}
