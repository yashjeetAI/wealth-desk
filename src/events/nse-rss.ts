import type { FilingEvent } from "./types";

/** NSE's public feed of the latest ~280 announcements (about 12 hours). */
export const NSE_RSS_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml";

export interface NseItem extends FilingEvent {
  company: string;
  /** From the PDF file name (e.g. RADICO_10112026123652_x.pdf). Null when the link doesn't carry it. */
  symbol: string | null;
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** "10-Nov-2026 12:37:13" (IST) -> "2026-11-10T12:37:13+05:30". Null if unreadable. */
export function nseDate(s: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}+05:30`;
}

/** Symbol from the PDF name, e.g. .../corporate/M&M_10112026..._x.pdf -> "M&M". */
export function symbolFromLink(url: string): string | null {
  const m = /\/corporate\/([A-Z0-9&.\-]+)_\d{14}_/i.exec(url);
  return m ? m[1].toUpperCase() : null;
}

const tag = (item: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? decode(m[1]) : "";
};

/** Parse the feed. Items without a readable date are skipped. */
export function parseNseRss(xml: string): NseItem[] {
  const out: NseItem[] = [];
  for (const chunk of xml.split("<item>").slice(1)) {
    const item = chunk.slice(0, chunk.indexOf("</item>"));
    const date = nseDate(tag(item, "pubDate"));
    if (!date) continue;
    const url = tag(item, "link") || null;
    const desc = tag(item, "description");
    const cut = desc.indexOf("|SUBJECT:");
    const text = (cut >= 0 ? desc.slice(0, cut) : desc).trim();
    const subject = cut >= 0 ? desc.slice(cut + 9).trim() : "";
    const company = tag(item, "title");
    const title = text.replace(/^.*? has informed the Exchange (about|regarding|that)\s*/i, "").replace(/\s*\.$/, "") || text;
    out.push({ company, symbol: url ? symbolFromLink(url) : null, title, category: subject, date, url });
  }
  return out;
}
