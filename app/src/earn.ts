/**
 * Earn PAI: opt-in teaching mode for the voice conversation.
 *
 * - Off until the person turns it on and has heard how it works (public/learn/earn-pai.md, read
 *   aloud on first use). Only then does the voice model mark what they teach and the app offer it
 *   to the Learning Fabric (the router refuses teaching without this consent).
 * - Which areas to suggest is worked out on the device from the person's own chat history (subjects
 *   they ask about, and signs they speak from experience), what they have taught before, and where
 *   the network is thin. Their conversations never leave the device for this.
 */
import { api, API } from "./api";
import { classifyDomain } from "./domain";
import { listConversations } from "./localdb";

export const EARN_CONSENT = "earn-pai-v1";
const KEY = "dsi_earn_pai";

export function earnOptedIn(): boolean {
  try {
    return localStorage.getItem(KEY) === EARN_CONSENT;
  } catch {
    return false;
  }
}

export function setEarnOptIn(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, EARN_CONSENT);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: it lasts for this visit */
  }
}

// ---------------------------------------------------------------- the person's areas

export interface Area {
  domain: string;
  /** Spoken name, e.g. "accounting". */
  label: string;
  /** Their questions in this area. */
  asked: number;
  /** Messages where they spoke from experience or corrected DSI. */
  expertise: number;
  /** Knowledge they already taught here. */
  taught: number;
  /** No expert node serves this area yet: teaching it fills a real gap. */
  gap: boolean;
  score: number;
}

const LABELS: Record<string, string> = {
  law: "law",
  "law.corporate": "company law",
  "law.securities": "securities law",
  "law.tax": "tax law",
  finance: "finance",
  "finance.accounting": "accounting",
  medicine: "medicine",
  "medicine.primary_care": "primary care",
  software: "software",
  "software.python": "Python",
  "software.sql": "databases and SQL",
  mathematics: "mathematics",
  "mathematics.calculus": "calculus",
  "mathematics.probability": "probability",
  travel: "travel",
  "travel.europe": "travel in Europe",
  agriculture: "agriculture",
  "agriculture.crops": "growing crops",
};
export const areaLabel = (d: string) => LABELS[d] ?? d.split(".").at(-1)!.replace(/_/g, " ");

/** Speaking from experience, or correcting DSI: the strongest sign of knowledge worth teaching. */
const EXPERIENCE =
  /\b(?:i work(?:ed)? (?:as|in|at)|as an? [a-z]+ (?:i|we)|in my (?:experience|job|work|practice|field|country|town|company)|we (?:usually|always|normally) |at my (?:work|job|company|clinic|farm)|i(?:'ve| have) been (?:a|an|working|doing)|actually,? (?:it|that|the)|that'?s (?:not right|wrong|incorrect)|you(?:'re| are) wrong|the correct (?:answer|way)|i'm an? |i am an? )/i;

/** What to teach in each area: the kinds of knowledge models usually lack. */
const PROMPTS: Record<string, string> = {
  law: "a rule that changed recently, or how a law is really applied where you live",
  "finance.accounting": "how a tricky transaction is really booked, or a local tax rule that AI gets wrong",
  finance: "how something in your market really works today",
  medicine: "what is done in practice that textbooks leave out (no patient details, ever)",
  software: "a fix for a bug or a library behaviour that is not in the documentation",
  mathematics: "a worked result or calculation, which can be checked straight away",
  travel: "local, current facts: prices, rules, routes and what to avoid",
  agriculture: "what works on the ground: timing, soil, pests and local conditions",
};
export const teachPrompt = (d: string) => PROMPTS[d] ?? PROMPTS[d.split(".")[0]] ?? "something from your own experience that AI tends to get wrong";

export async function profileAreas(): Promise<Area[]> {
  const by = new Map<string, Area>();
  const area = (d: string) => {
    let a = by.get(d);
    if (!a) by.set(d, (a = { domain: d, label: areaLabel(d), asked: 0, expertise: 0, taught: 0, gap: false, score: 0 }));
    return a;
  };
  // 1. The person's own conversations, read on this device.
  try {
    for (const c of await listConversations())
      for (const m of c.messages) {
        if (m.role !== "user") continue;
        const d = classifyDomain(m.content);
        if (!d) continue;
        const a = area(d);
        a.asked++;
        if (EXPERIENCE.test(m.content)) a.expertise++;
      }
  } catch {
    /* no history yet */
  }
  // 2. What they have taught before, and 3. where the network has no expert yet.
  const [me, map, gaps] = await Promise.all([
    api<{ objects: Array<{ domain: string; state: string }> }>("/learning/me").catch(() => undefined),
    fetch(`${API}/api/network/map`).then((r) => r.json() as Promise<{ cities: Array<{ node_list?: Array<{ domains: Record<string, number> }> }> }>).catch(() => undefined),
    api<{ gaps: Array<{ domain: string }> }>("/learning/gaps").catch(() => undefined),
  ]);
  for (const o of me?.objects ?? []) if (o.domain && o.domain !== "general" && o.state !== "REJECTED") area(o.domain).taught++;
  const covered = new Set<string>();
  for (const c of map?.cities ?? []) for (const n of c.node_list ?? []) for (const d of Object.keys(n.domains ?? {})) covered.add(d);
  const fabricGaps = new Set((gaps?.gaps ?? []).map((g) => g.domain));
  for (const a of by.values()) {
    a.gap = fabricGaps.has(a.domain) || !(covered.has(a.domain) || covered.has(a.domain.split(".")[0]));
    a.score = a.asked + a.expertise * 4 + a.taught * 3 + (a.gap ? 2 : 0);
  }
  return [...by.values()].sort((x, y) => y.score - x.score).slice(0, 3);
}

/** The personal part of the onboarding, spoken after the guide. */
export function areasText(areas: Area[]): string {
  if (!areas.length)
    return "I don't know your areas yet. As we talk, I'll learn what you know well. For now, tell me something from your own experience that AI tends to get wrong.";
  const lines = areas.map((a) => {
    const why = a.expertise ? "you speak about it from experience" : a.taught ? "you have taught me about it before" : "you often talk about it";
    return `${a.label}, because ${why}${a.gap ? ", and the network has no expert in it yet, so it is worth more" : ""}. Try ${teachPrompt(a.domain)}.`;
  });
  return `From your conversations on this device, these are the areas where your knowledge is likely worth the most. ${lines.join(" ")}`;
}

// ---------------------------------------------------------------- the guide

export interface GuideSection {
  title: string;
  paragraphs: string[];
}

/** The learning journey (public/learn/earn-pai.md), as sections of spoken paragraphs. */
export async function loadGuide(): Promise<GuideSection[]> {
  const md = await (await fetch("/learn/earn-pai.md", { cache: "no-cache" })).text();
  const out: GuideSection[] = [];
  for (const block of md.replace(/<!--[\s\S]*?-->/g, "").split(/\n(?=#{1,2} )/)) {
    const [head, ...rest] = block.trim().split("\n");
    if (!head) continue;
    const title = head.replace(/^#+\s*/, "").trim();
    const paragraphs = rest
      .join("\n")
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    out.push({ title, paragraphs });
  }
  return out;
}
