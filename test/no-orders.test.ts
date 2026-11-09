// Safety net: fails if any trading capability appears in the code or the tool list.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/tools";
import { connect } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FORBIDDEN = [
  /place_?order/i,
  /modify_?order/i,
  /cancel_?order/i,
  /convert_?position/i,
  /\bgtt\b/i,
  /createRule|modifyRule|cancelRule/i,
  /\/order\/(create|modify|cancel)/i,
  /smart-?order/i,
  /\/order\/v1\/(?!getPosition)/i, // the only allowed Angel /order/ path is getPosition (read-only)
];

describe("no trading", () => {
  it("source has no order, modify, cancel or GTT code", () => {
    const hits: string[] = [];
    for (const f of files(join(here, "../src"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("tool list is exactly the read-only set", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const n of names) expect(n).not.toMatch(/order|buy|sell|cancel|modify|gtt|trade/i);
  });

  it("only GET requests reach broker data endpoints (POST only for login)", () => {
    const src = files(join(here, "../src/brokers")).map((f) => readFileSync(f, "utf8")).join("\n");
    const posts = src.match(/method:\s*"(POST|PUT|DELETE|PATCH)"/g) ?? [];
    expect(posts).toEqual(['method: "POST"', 'method: "POST"', 'method: "POST"']); // angel, groww, kite logins
  });
});
