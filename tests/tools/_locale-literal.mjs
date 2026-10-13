/**
 * Guard: no behaviour may be **pinned to one specific language** outside the
 * i18n layer.
 *
 * ## Why this exists
 *
 * The platform ships with two languages today and is meant to carry dozens. The
 * difference is not "more content" — it is that a two-language install cannot
 * tell you which code assumed there are two. Three shapes do:
 *
 *   1. `locale === "en"` — a branch that only the author's languages take.
 *   2. `/^zh/i.test(locale)` — the same thing in a regex, which reads like
 *      language detection and is really a two-way switch.
 *   3. `["en", "zh-CN"]` — a hardcoded language list. The authority is
 *      `platform/i18n/locale-registry.ts`; a second list drifts from it.
 *
 * None of these fail today. All of them fail the day someone enables Japanese,
 * and the failure is silent (the page renders, in the wrong language).
 *
 * ## What counts as a hit
 *
 * A — a comparison whose other side names a locale (`locale === "en"`).
 * B — a regex test/match on a locale-shaped subject (`/^zh/i.test(locale)`).
 * C — two or more locale-shaped literals on one line that also mentions locale.
 * D — a literal from the unambiguous locale set, outside the allow-list.
 *
 * Comments are stripped first: this repo has already been burned by a token
 * count that read the raw source, where a mention inside `{{! … }}` faked a
 * match (ARCHITECTURE.md §12 #11). The same trap applies to `// … "zh-CN"`.
 *
 * ## Why the allow-list carries a reason
 *
 * A bare allow-list rots. Every entry below has to justify itself, so it gets
 * re-read when someone adds the next one — the same convention
 * `contract/schema.ts` uses for its scope declarations.
 *
 * Usage: node tests/tools/_locale-literal.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Files where a locale literal is the point, not a leak. The i18n layer is
 * *where* "which languages exist" is answered; anywhere else, a literal is a
 * second answer (rule 23).
 */
const ALLOWED = {
  "src/platform/i18n/locale-registry.ts":
    "the registry IS the answer to 'which languages exist'; TERMINAL_LOCALE is declared here once, and the platform dictionary seed lives here",
  "src/platform/i18n/packs.ts":
    "interface-language pack selection — 'en' is the preferred fallback *dictionary*, a policy about UI strings, not about content languages",
  "src/platform/i18n/core-pack.ts":
    "the platform dictionary itself: every key carries one entry per shipped language, so `\"zh-CN\": …` here IS the language pack",
  "src/extensions/plugin/packs.ts":
    "the shape a plugin's language pack takes (documentation example in the header comment)",
  "src/extensions/contract/validation.ts":
    "BCP-47 error-message examples ('expected BCP-47 shape, e.g. \"en\", \"zh-CN\"') — prose shown to an extension author",
  "src/platform/frontend.ts":
    "⚠️ KNOWN GAP: `readingTime()` still picks its label with `/^zh/i.test(locale)` — a two-way switch that will print 'min read' on a Japanese page. Tracked in docs/CHANGE-CONTRACT.md §6; the fix is for the label to come from the language pack, not from TypeScript. This entry exists so the gap is *counted*, not blessed.",
};

/**
 * Unambiguous locale codes. Ambiguous two-letter codes are deliberately absent:
 * `"id"`, `"no"`, `"in"`, `"is"`, `"it"`, `"hi"`, `"pl"` and friends are far
 * more likely to be an ordinary string than a language, and a guard that cries
 * wolf gets switched off.
 */
const CODES = new Set([
  "en", "zh", "zh-CN", "zh-TW", "ja", "ko", "fr", "de", "es", "ru", "ar",
  "pt", "tr", "vi", "th", "nl", "sv", "da", "fi", "el", "he", "uk", "cs",
]);
const LOCALE_SHAPE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

/** Strip `//`, `/* *\/` and the *content* of template literals' `${}` holes. */
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; out += c; i++;
      while (i < src.length) { if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const files = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(join(ROOT, "src"));

/** rule → [regex, human name]; the regex must expose the literal in group 1. */
// Deliberately narrow. An earlier draft also flagged *any* `x === "…"`
// comparison, which lit up the template parser (`t.t === "id"`) and the
// feature-flag parser (`s === "1"`) — noise that would have got the guard
// switched off on its first day. Rule D below is the actual net; A and B exist
// to name the shape precisely in the report.
// ⚠️ Every rule MUST expose the literal (or its prefix) in group 1: the caller
// filters on `m[1]`, so a rule without a capture group silently never fires —
// which is what happened to rule B on the first draft, and is the same
// "assertion that cannot fail" shape this repo keeps re-learning.
const RULES = [
  [/(?:[A-Za-z_$][\w$]*\.)?(?:locale|lang|Locale|Lang)\w*\s*(?:===|!==|==|!=)\s*["']([^"']+)["']/g, "A comparison against a locale"],
  [/\/\^?([a-zA-Z-]{2,10})\/i?\.(?:test|exec)\(\s*(?:[A-Za-z_$][\w$]*\.)?(?:locale|lang)/g, "B regex test on a locale"],
];

const hits = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(/[\\/]/).join("/");
  if (ALLOWED[rel]) continue;
  const src = stripComments(readFileSync(file, "utf8"));
  src.split("\n").forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    for (const [re, label] of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const lit = m[1];
        // Rule A/B are only interesting for a *locale* literal; `x === "foo"`
        // is a normal comparison and the second rule exists only to catch the
        // `locale` spelling the first one misses.
        if (!LOCALE_SHAPE.test(lit) && !CODES.has(lit)) continue;
        hits.push({ where, label, line: line.trim().slice(0, 120) });
      }
    }
    // C — a hardcoded language list on a locale-ish line. Case-insensitive:
    // the realistic spelling is `const LOCALES = [...]`, and a case-sensitive
    // match let exactly that shape through.
    if (/\b(?:locale|lang)\w*/i.test(line)) {
      const lits = [...line.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).filter((x) => LOCALE_SHAPE.test(x));
      if (lits.length >= 2) hits.push({ where, label: "C hardcoded language list", line: line.trim().slice(0, 120) });
    }
    // D — any unambiguous locale literal at all.
    for (const m of line.matchAll(/["']([^"']+)["']/g)) {
      if (CODES.has(m[1])) hits.push({ where, label: "D locale literal outside the i18n layer", line: line.trim().slice(0, 120) });
    }
  });
}

// One line can trip several rules (a comparison is also a literal). Report it
// once per rule, not once per match.
const seen = new Set();
const unique = hits.filter((h) => {
  const k = `${h.where}|${h.label}|${h.line}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
hits.length = 0;
hits.push(...unique);

console.log("Locale-literal guard: behaviour pinned to one language, outside the i18n layer\n");
if (!hits.length) {
  console.log("  (none)");
} else {
  const pad = Math.max(...hits.map((h) => h.where.length));
  for (const h of hits) console.log(`  ${h.where.padEnd(pad)}  [${h.label}]  ${h.line}`);
}

console.log("\nAllow-listed (each entry has to justify itself):");
for (const [f, why] of Object.entries(ALLOWED)) console.log(`  ${f}\n      ${why}`);

if (hits.length) {
  console.log(`\n${hits.length} hit(s). A language literal outside the i18n layer is a second answer`);
  console.log("to 'which languages exist' — put it in platform/i18n/, or add an allow-list entry");
  console.log("with a reason (and tell the truth about it).");
  process.exit(1);
}
console.log("\nNo locale literal outside the allow-list.");
