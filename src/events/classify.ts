import type { Flag } from "./types";

// Rules, not an LLM. Checked in order: the first match wins, so REVIEW beats WATCH beats INFO.
const RULES: [Exclude<Flag, "other">, RegExp][] = [
  [
    "review",
    /pledg|encumbr|auditor.{0,40}resign|resignation.{0,40}auditor|\bdefault|delay in (payment|servicing|repayment)|sebi.{0,40}order|order.{0,40}sebi|show.cause|insolvency|\bcirp\b|\bibc\b|forensic audit|fraud|search and seizure|action\(s\) initiated|orders? passed/i,
  ],
  [
    "watch",
    /financial results|\bresults\b|analyst|investor meet|con\.? call|conference call|earnings call|credit rating|\bratings?\b|bulk deal|block deal|order (win|received|inflow)|receipt of (an? )?order|bag(s|ged)? .{0,40}order|award of (contract|order)|letter of award|acqui(re|sition)|merger|amalgamation|takeover|open offer/i,
  ],
  ["info", /dividend|stock split|sub-?division|\bsplit\b|bonus|board meeting|record date|book closure|annual general meeting|\bagm\b/i],
];

export function classify(title: string, category = ""): Flag {
  const s = `${category} ${title}`;
  for (const [flag, re] of RULES) if (re.test(s)) return flag;
  return "other";
}

export const FLAG_ORDER: Record<Flag, number> = { review: 0, watch: 1, info: 2, other: 3 };
