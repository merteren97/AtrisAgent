export const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = '20m';

const ANTIGRAVITY_TIMEOUT_PATTERN = /^[1-9]\d*(?:ms|s|m|h)$/i;

/**
 * Antigravity print mode defaults to a relatively short terminal wait. AtrisAgent
 * missions routinely perform repository research/build work that can exceed that
 * window, so background agents get a longer bounded timeout. An installation can
 * override it through ATRIS_ANTIGRAVITY_PRINT_TIMEOUT without allowing arbitrary
 * CLI arguments to cross this boundary.
 */
export function resolveAntigravityPrintTimeout(
  value = process.env.ATRIS_ANTIGRAVITY_PRINT_TIMEOUT,
): string {
  const normalized = String(value || '').trim().toLowerCase();
  return ANTIGRAVITY_TIMEOUT_PATTERN.test(normalized)
    ? normalized
    : DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT;
}
