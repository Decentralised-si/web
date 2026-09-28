/**
 * Subject domain of a question, worked out here in the browser and sent to the gateway as the
 * X-Decentralise-Domain hint, so specialist nodes (law, accounting, ...) get the questions they
 * are best at. The gateway never reads prompts to route them.
 * Mirrors classifyDomain in the router repo (packages/core/src/difficulty.ts); keep them in step.
 */
const DOMAIN_TERMS: Array<[string, RegExp]> = [
  ["law.corporate", /\b(director'?s?|corporations act|shareholders?|asic|insolvent trading|business judg(e)?ment rule|company law|board of directors)\b/gi],
  ["law.tax", /\b(tax law|tax return|capital gains|ato|irs|withholding tax)\b/gi],
  ["law", /\b(law|legal|lawyers?|liab(le|ility)|sue|lawsuit|court|contract|breach|negligence|duty of care|tort|statute|section \d+|consumer law|acl|unfair (dismissal|contract)|limitation period|damages|plaintiff|defendant)\b/gi],
  ["finance.accounting", /\b(accounting|accountant|bookkeeping|double[- ]entry|journal entr(y|ies)|debit|ledger|trial balance|depreciat\w*|amorti[sz]ation|accrual|prepa(id|yment)|aasb|ifrs|gaap|revenue recognition|deferred revenue|invoice|gst|bas|fifo|lifo|inventory|cogs|impairment|balance sheet|income statement|reconciliation|capitali[sz]ation threshold)\b/gi],
];

/** The best-supported subject domain for a text, or undefined when nothing specific stands out. */
export function classifyDomain(text: string): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  const scores = new Map<string, number>();
  for (const [domain, re] of DOMAIN_TERMS) scores.set(domain, text.match(re)?.length ?? 0);
  // A sub-domain's evidence also counts towards its parent (law.corporate is law).
  for (const [domain, n] of scores) {
    const total = n + (domain.includes(".") ? 0 : [...scores].filter(([d]) => d.startsWith(domain + ".")).reduce((a, [, m]) => a + m, 0));
    if (total > bestScore) (best = domain), (bestScore = total);
  }
  if (!best) return undefined;
  // Prefer the most specific domain that has its own evidence.
  const child = [...scores].filter(([d, n]) => d.startsWith(best + ".") && n > 0).sort((a, b) => b[1] - a[1])[0];
  return child ? child[0] : best;
}
