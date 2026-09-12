import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Matches invocations and ambient access, never a type declaration: the RawEvidenceIndex
// port legitimately declares a method named `fetch`, which is not a network call.
const FORBIDDEN = [
  /\bawait\s+fetch\s*\(/,
  /(?:globalThis|window|global)\s*\.\s*fetch\b/,
  /=\s*fetch\s*\(/,
  /from\s+["']node:/,
  /\brequire\s*\(/,
  /process\.env/,
  /\bnew Date\s*\(\s*\)/,
  /\bDate\.now\s*\(/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("core purity", () => {
  it("contains no I/O or ambient clock access", () => {
    const offenders: string[] = [];
    for (const file of walk(join(import.meta.dirname, "../src"))) {
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
