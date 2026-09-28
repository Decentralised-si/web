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
  ["law.securities", /\b(securities law|insider trading|prospectus|disclosure obligations?|market manipulation|continuous disclosure|sec filing|asx listing rules)\b/gi],
  ["medicine.primary_care", /\b(gp|general practi(ce|tioner)|family (doctor|medicine)|primary care|check-?up|referral|prescri(be|ption)|blood pressure|vaccinat\w*|cholesterol)\b/gi],
  ["medicine", /\b(medicine|medical|doctor|symptoms?|diagnos\w*|disease|illness|treatment|patient|clinical|fever|infection|diabetes|asthma|hypertension|dose|dosage|medication|side effects?|pain|headache|cancer|heart attack|stroke|nurse|hospital)\b/gi],
  ["software.python", /\b(python|pip|pandas|numpy|django|flask|pytest|virtualenv|venv|list comprehension|pep ?8)\b/gi],
  ["software.sql", /\b(sql|select \*|inner join|left join|postgres(ql)?|mysql|sqlite|database index|primary key|foreign key|query plan|normali[sz]ation)\b/gi],
  ["software", /\b(software|programming|code|coding|bug|debug\w*|compile\w*|api|javascript|typescript|java|rust|golang|git|docker|kubernetes|algorithm|function|refactor\w*|unit tests?|frontend|backend|deploy\w*)\b/gi],
  ["mathematics.calculus", /\b(calculus|derivative|integral|integrat(e|ion)|differentiat\w*|limit of|chain rule|taylor series|gradient)\b/gi],
  ["mathematics.probability", /\b(probabilit\w*|random variable|expected value|variance|bayes|distribution|binomial|poisson|odds|dice|coin (toss|flip))\b/gi],
  ["mathematics", /\b(math(s|ematics)?|algebra|geometry|equation|theorem|proof|prime numbers?|matrix|matrices|vector|trigonometr\w*|arithmetic|fraction|polynomial|logarithm)\b/gi],
  ["travel.europe", /\b(europe(an)?|schengen|eurail|interrail|eurostar|euro zone|eurozone)\b/gi],
  ["travel", /\b(travel\w*|trip|holiday|vacation|flights?|airport|hotel|hostel|itinerary|visa|passport|luggage|backpack\w*|tourist|sightseeing|jet lag)\b/gi],
  ["agriculture.crops", /\b(crops?|wheat|maize|corn|rice|barley|soybeans?|harvest|sowing|planting|yield|irrigation|fertili[sz]er|pesticide|crop rotation|seeds?)\b/gi],
  ["agriculture", /\b(agricultur\w*|farm(s|ing|er|ers)?|livestock|cattle|sheep|poultry|dairy|soil|tractor|agronom\w*|pasture|orchard|greenhouse)\b/gi],
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
