/**
 * Architecture tests — the machine enforcement of docs/ARCHITECTURE.md.
 *
 * These do not test behaviour. They test *shape*: which layer may depend on
 * which, what must never appear in an extension, and which conventions are
 * non-negotiable. They exist because documentation cannot stop a future change
 * (human or AI) from drifting; a failing test can.
 *
 * Every test here corresponds to a numbered rule in docs/ARCHITECTURE.md §10.
 * When a rule changes there, change it here in the same commit.
 *
 * Usage: node tests/suites/architecture.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { langPackProblems, themeManifestProblems } from "../fixtures/_extension-rules.mjs";
// The editor palette must be this array (see the one-definition guard below).
import { CORE_BLOCKS, BLOCK_ATTR_TYPES } from "../../src/rendering/blocks.ts";
// The field-type classification is imported, never re-listed: the validator and
// the scaffolder read the same source, so "is this field prose?" has one answer.
import {
  ALLOWED_AGGREGATES,
  ALLOWED_FIELD_TYPES,
  ALLOWED_PAGE_BLOCKS,
  ALLOWED_TABLE_FIELD_TYPES,
  LANGUAGE_NEUTRAL_FIELD_TYPES,
  PLUGIN_PAGE_SCREEN_PREFIX,
  PROSE_FIELD_TYPES,
  isProseFieldType,
} from "../../src/extensions/contract/manifest.ts";
// The channel contract's closed type set has to agree with the admin control
// list, the same way the table field types do. Imported, not copied.
import { ALLOWED_CHANNEL_FIELD_TYPES, HOST_CHANNEL_CODES } from "../../src/extensions/contract/channels.ts";
// The shipped-theme set has one definition, and the script that produces
// `public/themes` is the one that reads it. This suite imports that same parse
// instead of keeping a second copy of the regex: two copies is how the fixture
// theme shipped for as long as it did (see the bundled-themes section below).
import { BUNDLED_SRC, readBundledThemeNames } from "../../scripts/sync-bundled-themes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  // ⚠️ The condition must be a **boolean**.
  //
  // `check("…", offenders, [])` reads as "assert no offenders" and asserts
  // nothing, because an empty array is truthy. So does
  // `check("…", JSON.stringify(a), JSON.stringify(b))` — a non-empty string is
  // truthy. This file shipped both spellings, and only the injection tool
  // caught them: the suite was green with a guard that could not fail.
  //
  // The lexical patterns further down catch those two shapes early, but a
  // pattern can only ban the spellings someone thought of. This check bans the
  // *class*: whatever the condition is, it has to be an actual boolean, so a
  // missing comparison is a loud TypeError instead of a silent `ok`.
  if (typeof condition !== "boolean") {
    const kind = Array.isArray(condition) ? "array" : condition === null ? "null" : typeof condition;
    throw new TypeError(
      `check("${name}") needs a boolean condition, got ${kind}: ${String(condition).slice(0, 90)}`
    );
  }
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Assert a list is empty — the *only* correct way to write "no offenders".
 *
 * ⚠️ Do not write `check(name, offenders, [])`. `check` tests **truthiness**,
 * and an empty array is truthy, so that spelling asserts nothing and cannot
 * fail. Seven guards in the batch-6 sections were written that way and stayed
 * green with a blatant defect (a duplicate `MediaUploaded`) sitting on disk —
 * the eighth false-green in this repo, and the first one *inside the guards*.
 *
 * This helper exists so the intent is expressible without repeating
 * `offenders.length === 0` at every call site; the parameter name is `offenders`
 * rather than `list` to make the call read as the rule it enforces.
 */
function checkEmpty(name, offenders) {
  const list = Array.isArray(offenders) ? offenders : [offenders];
  check(
    name,
    list.length === 0,
    list.length ? `${list.length}: ${list.join(" | ")}` : ""
  );
}

/**
 * Guard the guard: no `check()` may pass a collection as its condition.
 *
 * A shape error in an assertion is invisible at runtime — the assertion simply
 * never fails — so it has to be caught *lexically*. This scans this file for
 * the exact spelling above and fails if it reappears. It is the same idea as
 * `tests/suites/architecture.test.mjs` refusing to match strings where a structure
 * needs parsing: here the "structure" is the argument being a bare identifier
 * whose name is in a known collection-noun set.
 *
 * Keep this near `checkEmpty` so the two read together.
 */
function findTruthyCollectionCalls(src) {
  // Any `check(<string>, <anything>, [])`. The third argument of `check` is a
  // *detail string*, so passing `[]` there means the author believed this was a
  // comparison helper — and whatever they passed as the condition (a bare
  // identifier, `.filter(...)`, a spread) is being tested for **truthiness**.
  // An array is always truthy, so the assertion cannot fail.
  //
  // Matching any expression, not just a bare identifier, matters: the first
  // version of this scan only caught `check("x", someList, [])`, and two
  // vacuous calls whose condition was `.filter(...)` sailed through.
  const re = /check\(\s*"[^"]*"\s*,\s*[\s\S]*?,\s*\[\]\s*\)/g;
  return [...src.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ").slice(0, 80));
}

function section(title) {
  console.log(`\n${title}`);
}

/** Every file under `dir` whose name ends with one of `exts`. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/**
 * Replace comments with same-length whitespace, preserving newlines.
 *
 * Guards below must read *code*, not prose: several of them document the very
 * pattern they forbid, and a guard that fires on its own explanatory comment is
 * unusable. Deleting comments outright would work too — but then every reported
 * line number drifts upward by the size of the comments above it, and an
 * offender list that points at the wrong line trains people to ignore it.
 */
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent);
}

// ---------------------------------------------------------------------------
section("Layer boundaries (docs/ARCHITECTURE.md §7.3)");
// ---------------------------------------------------------------------------

/**
 * Rule 2/3: platform and rendering must not know about extensions.
 *
 * This is the load-bearing rule behind "a theme or plugin can be added or
 * removed without touching the platform". If platform code imported an
 * extension, that extension would silently become a hard dependency.
 *
 * Paths are resolved rather than text-matched, for the same reason as the
 * theme/plugin check below: `"../extensions/..."` is the real spelling, and a
 * naive `includes("/extensions/")` test is easy to fool.
 */
const extensionRoot = join(ROOT, "src/extensions");
const platformOffenders = [];
for (const pdir of ["src/platform", "src/rendering"]) {
  const dir = join(ROOT, pdir);
  for (const f of walk(dir, [".ts"])) {
    for (const m of read(f).matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const abs = resolve(dirname(f), spec);
      const relToExt = relative(extensionRoot, abs);
      if (relToExt !== "" && !relToExt.startsWith("..") && !isAbsolute(relToExt)) {
        platformOffenders.push(`${rel(f)} -> ${spec}`);
      }
    }
  }
}
check(
  "platform/ and rendering/ do not import extensions/",
  platformOffenders.length === 0,
  platformOffenders.join("\n       ")
);

/**
 * Rule 5: `shared/` is a leaf. It may not depend on any business layer.
 *
 * `shared/` is imported by everybody, so a dependency from it on `platform/`
 * or `extensions/` would make the whole dependency graph cyclic and mean a
 * change to a business rule could ripple into "pure" utilities.
 */
const sharedDir = join(ROOT, "src/shared");
const sharedOffenders = [];
for (const f of walk(sharedDir, [".ts"])) {
  for (const m of read(f).matchAll(/from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const abs = resolve(dirname(f), spec);
    for (const forbidden of ["platform", "rendering", "extensions"]) {
      const relTo = relative(join(ROOT, "src", forbidden), abs);
      if (relTo !== "" && !relTo.startsWith("..") && !isAbsolute(relTo)) {
        sharedOffenders.push(`${rel(f)} -> ${spec}  (reaches ${forbidden}/)`);
      }
    }
  }
}
check(
  "shared/ depends on no business layer",
  sharedOffenders.length === 0,
  sharedOffenders.join("\n       ")
);

/**
 * Rule 4: themes and plugins must not import each other.
 *
 * Both consume the *same* host interface, which is what makes "a plugin can
 * register an admin menu" free rather than a special case. A cross-import
 * would break that symmetry and couple two independently-installable units.
 *
 * ## Why this check resolves paths instead of matching text
 *
 * An earlier version tested `spec.includes("/extensions/plugin/")`. That never
 * matched anything in practice: the real specifier is `"../plugin/runtime"`,
 * which contains no `/extensions/` at all. The check passed vacuously — and an
 * injection test (adding `import ... from "../plugin/runtime"` to a theme)
 * confirmed it *still* passed. A guard against coupling that cannot see the
 * coupling is worse than no guard, because it is trusted.
 *
 * So we resolve each specifier against the file's own directory and compare
 * real paths. This also makes the check immune to how the import is spelled
 * (relative, aliased, or `from"..."` with no space).
 */
const themeDir = join(ROOT, "src/extensions/theme");
const pluginDir = join(ROOT, "src/extensions/plugin");

/** True when `spec` as written in `file` resolves into `targetDir`. */
function resolvesInto(file, spec, targetDir) {
  const abs = resolve(dirname(file), spec);
  const relToTarget = relative(targetDir, abs);
  return relToTarget !== "" && !relToTarget.startsWith("..") && !isAbsolute(relToTarget);
}

const crossOffenders = [];
for (const [sourceDir, targetDir, label] of [
  [themeDir, pluginDir, "plugin/"],
  [pluginDir, themeDir, "theme/"],
]) {
  for (const f of walk(sourceDir, [".ts"])) {
    const src = read(f);
    for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      if (resolvesInto(f, spec, targetDir)) {
        crossOffenders.push(`${rel(f)} -> ${spec}  (resolves into ${label})`);
      }
    }
  }
}
check(
  "theme/ and plugin/ do not import each other",
  crossOffenders.length === 0,
  crossOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Extensions never touch the database directly (§10 rule 9)");
// ---------------------------------------------------------------------------

/**
 * Rule 9: a theme must not write SQL. It declares a table and calls the host
 * facade; the platform owns the DDL, the naming and the migration path.
 *
 * Rationale (docs §3.3): business tables are generated, so a theme that issued
 * its own `CREATE TABLE` would produce a table the platform cannot see, name,
 * migrate or clean up.
 *
 * Only the *shipped* extension bundles are scanned. Test fixtures under
 * tests/ are allowed to reach into the database, since that is how they assert
 * what the platform did on the extension's behalf.
 */
const dbWriteRe = /\.prepare\s*\(\s*[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i;
for (const [label, dirs] of [
  ["content/themes/", ["content/themes"]],
  ["content/plugins/", ["content/plugins"]],
]) {
  const files = dirs.flatMap((d) => walk(join(ROOT, d), [".js", ".mjs", ".ts"]));
  const offenders = [];
  for (const f of files) {
    const src = read(f);
    // Strip comments so prose *about* SQL does not trip the check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (dbWriteRe.test(code)) offenders.push(rel(f));
  }
  check(
    `${label} contains no direct SQL`,
    offenders.length === 0,
    offenders.length ? `offenders: ${offenders.join(", ")}` : ""
  );
}

// ---------------------------------------------------------------------------
section("No hardcoded site / locale defaults (§10 rules 4, 5)");
// ---------------------------------------------------------------------------

/**
 * Rule 4: data-access functions take `siteId` and `locale` explicitly, with no
 * default value.
 *
 * A `siteId = "default"` default is how a multi-site bug hides: the call site
 * compiles, runs, and silently reads the wrong site's data. Making the
 * parameter required turns that into a compile error. This was the root cause
 * of the `activeTheme()` defect fixed in v0.7.0.
 *
 * ✅ SATISFIED as of the batch-1 cleanup: all 26 defaults are gone. The ratchet
 * that previously allowed them has been deleted — this is now a hard rule with
 * zero tolerance, so there is no constant left to quietly raise later.
 *
 * The pattern also matches *constant* defaults (`siteId = DEFAULT_SITE_ID`).
 * An earlier version only matched string literals, which let six constant-form
 * defaults sit in src/api.ts while the test reported the rule as merely
 * "tracked". A default is a default regardless of how it is spelled.
 *
 * Precision matters here: a naive `siteId\s*=` match also fires on SQL
 * fragments (`WHERE locale=?`), object-literal properties (`{ locale: x }`)
 * and ternaries (`locale = a ? b : c`). So the pattern is anchored to a
 * *function parameter list*: match `=` only when the token is followed by a
 * literal default and the enclosing bracket is a `(`. The lookahead for
 * `=>`/`?` excludes arrow bodies and ternaries.
 *
 * Carve-out: a default is legitimate when the value is *derived from the
 * request* — `requestSiteId(url)` falling back to the default site is the one
 * place the choice actually has to be made. That is written as a call, not a
 * literal default, so it does not match (and does not need an exception list).
 */
const defaultParamRe =
  /\b(siteId|locale)\s*(?::\s*[\w<>[\]| ]+)?\s*=\s*("default"|'default'|[A-Z][A-Z0-9_]{2,})\s*(?=[,)])/g;

const srcFiles = walk(join(ROOT, "src"), [".ts"]);
const defaultParamOffenders = [];
for (const f of srcFiles) {
  const src = read(f);
  const code = blankComments(src);
  for (const m of code.matchAll(defaultParamRe)) {
    // Confirm the match sits inside a parameter list: the nearest unmatched
    // `(` before it must not be a call to something else. A cheap, reliable
    // proxy is to require the match to be preceded by `(` or `,` on the same
    // logical line, which is how parameters are written.
    const before = code.slice(0, m.index);
    const lineStart = before.lastIndexOf("\n") + 1;
    const sameLine = code.slice(lineStart, m.index);
    if (!/[(,]\s*(?:readonly\s+)?\w+\s*(?::\s*[\w<>[\]| ]+)?\s*,?\s*$/.test(sameLine)) continue;

    const line = src.slice(0, m.index).split("\n").length;
    defaultParamOffenders.push(`${rel(f)}:${line}  ${m[0].trim()}`);
  }
}

check(
  "no `siteId`/`locale` parameter defaults anywhere in src/",
  defaultParamOffenders.length === 0,
  defaultParamOffenders.length
    ? `make the parameter required and fix the call sites instead:\n       ${defaultParamOffenders.join("\n       ")}`
    : ""
);

/**
 * Rule 4, second form: *fallback expressions* that produce the same effect as a
 * parameter default.
 *
 * The check above matches `siteId = "default"`. It does **not** match
 * `o.siteId ?? "default"` — and that is not a technicality. When this guard was
 * first written it caught the `=` spelling and the constant spelling; by
 * v0.7.1 two `??`/`||` fallbacks had quietly reappeared
 * (`runtime-declarative.ts` `o.siteId ?? "default"`, `api.ts` `|| "en"`).
 * **The problem had not been eliminated — it had been pushed from `=` into
 * `??`.** A guard that matches one spelling of an intent teaches the next
 * author to use the other.
 *
 * So this matches the *operator* forms: `??` and `||` whose right-hand side is
 * a site/locale literal. Together with the parameter check above, every way of
 * spelling "silently fall back to the default" is now covered.
 *
 * Legitimate carve-outs, and why they do not match:
 *  - `requestSiteId(url)` returns `DEFAULT_SITE_ID` — but as a `return`, not as
 *    a `??`/`||` operand. That is the one place the choice has to be made.
 *  - `x || y` where `y` is a *variable* (e.g. `const next = enabled.find(...)`)
 *    is not a hardcoded default and does not match.
 *  - Reading `?site=` and validating with a regex does not match: the fallback
 *    is inside `requestSiteId`.
 */
const fallbackLiteralRe =
  /(?:^|[^\w$])(?:siteId|locale)\b[^\n]{0,120}?(\?\?|\|\|)\s*(?:"(?:default|en)"|'(?:default|en)'|DEFAULT_SITE_ID)/g;

/**
 * An exemption marker, deliberately spelled as a comment so it can be grepped
 * and reviewed. There is exactly one legal site/locale fallback in the
 * codebase — `resolveSite()` in `platform/sites.ts` — and this is how that file
 * declares it. Any other caller that wants one must come here and argue for it
 * in review, rather than quietly typing `?? "default"`.
 *
 * Why a marker instead of an exception list in this test: a list here would be
 * invisible from the source file. A marker lives next to the code it excuses,
 * so a reader of `sites.ts` sees why it is allowed, and a reader of this test
 * sees that only one marker is expected.
 */
const EXEMPT_MARKER = "ARCH-RULE-EXEMPT: site-default";

const fallbackOffenders = [];
const exemptFiles = [];
for (const f of srcFiles) {
  const raw = read(f);
  const hasMarker = raw.includes(EXEMPT_MARKER);
  if (hasMarker) exemptFiles.push(rel(f));
  // Same comment-stripping rationale as above: this file's own prose quotes
  // the offending forms, and a guard that trips on its own documentation is a
  // guard nobody can keep.
  //
  // Strip comments by replacing them with *newlines equal to their length*, so
  // offsets still line up with the original file. Blanking with "" would shift
  // every reported line number, and a guard that points at the wrong line is a
  // guard people learn to ignore.
  const code = blankComments(raw);
  for (const m of code.matchAll(fallbackLiteralRe)) {
    if (hasMarker) continue;
    const line = code.slice(0, m.index).split("\n").length;
    fallbackOffenders.push(`${rel(f)}:${line}  ${m[0].trim()}`);
  }
}

check(
  "no `siteId`/`locale` fallback to a hardcoded default (`??` / `||`)",
  fallbackOffenders.length === 0,
  fallbackOffenders.length
    ? `resolve the value at its source instead of falling back here; if this is\n` +
      `       genuinely the one place the choice is made, spell it as an explicit\n` +
      `       branch in requestSiteId()/resolveSite():\n       ${fallbackOffenders.join("\n       ")}`
    : ""
);

// The exemption must stay narrow. Count *markers*, not "files where a marker
// happened to matter" — an earlier version of this check only counted a marker
// when the same file also contained an offence, so a second file could claim
// the exemption for free as long as it had nothing to exempt. A guard whose
// scope depends on the absence of violations cannot see scope creep.
check(
  "the fallback exemption is confined to the documented single site",
  exemptFiles.length <= 1,
  exemptFiles.length > 1
    ? `${exemptFiles.length} files carry "${EXEMPT_MARKER}": ${exemptFiles.join(", ")}.\n` +
      `       Only resolveSite() in src/platform/sites.ts may. If this is\n` +
      `       intentional, update §10 rule 4 and this test in the same commit.`
    : ""
);

// ---------------------------------------------------------------------------
section("i18n key namespacing (§10 rule 7)");
// ---------------------------------------------------------------------------

/**
 * Rule 11 (§10): every key in an extension's language pack must carry its
 * owner's prefix — `theme.{name}.` or `plugin.{name}.`.
 *
 * Without this, two extensions that both define `nav.home` overwrite each
 * other in the merged dictionary, and which one wins depends on load order.
 * That is a heisenbug with no correct fix at the call site.
 *
 * The rule itself lives in `tests/fixtures/_extension-rules.mjs`, because
 * `tests/suites/scaffold.test.mjs` asks the same question of a *generated* theme. A
 * copied rule drifts from the original, and the copy is always the stale one.
 */
for (const kind of ["theme", "plugin"]) {
  const problems = langPackProblems(ROOT).filter((p) => p.startsWith(`content/${kind}s/`));
  check(
    `${kind} language packs are correctly namespaced`,
    problems.length === 0,
    problems.join("\n       ")
  );
}

// ---------------------------------------------------------------------------
section("Manifest declarations are internally consistent (§5.3)");
// ---------------------------------------------------------------------------

/**
 * A theme that declares a template it does not ship, or resolves a route
 * against a table it never declared, will fail at render time — deep inside a
 * request, with an error that points at the renderer rather than the manifest.
 * Catching it here makes the manifest the single place a theme can be wrong.
 *
 * Shared with the scaffold test for the same reason as the rule above: the
 * documented acceptance criterion for a generated theme is "passes the
 * architecture test", and running the real rule is the only honest way to say
 * that.
 */
const manifestProblems = themeManifestProblems(ROOT);
check(
  "theme manifests are internally consistent",
  manifestProblems.length === 0,
  manifestProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Every declared field carries multi-language capability (§10 rule 41)");
// ---------------------------------------------------------------------------

/**
 * The product rule this section enforces: **all data in this system has
 * multi-language capability**. A field holding prose must be translatable; a
 * field holding a number, flag or date must not be.
 *
 * Enforced at three levels, deliberately:
 *   1. the validator (`contract/validation.ts`) — catches third-party zips at
 *      install time, which the architecture test can never see;
 *   2. this test — catches *shipped* themes, with a better error message and
 *      without needing a running Worker;
 *   3. the scaffolder — so a newly generated theme is born compliant.
 *
 * The check below is the structural half: the two type lists must **partition**
 * the allowed set. Without it, adding a seventh field type would compile, pass
 * every conformance check (because no shipped theme uses it yet), and quietly
 * escape the rule — which is exactly how the previous guard generations died.
 */
const proseSet = new Set(PROSE_FIELD_TYPES);
const neutralSet = new Set(LANGUAGE_NEUTRAL_FIELD_TYPES);
const allowedSet = new Set(ALLOWED_TABLE_FIELD_TYPES);

const overlap = [...proseSet].filter((t) => neutralSet.has(t));
check(
  "prose and language-neutral field types do not overlap",
  overlap.length === 0,
  overlap.length ? `declared in both lists: ${overlap.join(", ")}` : ""
);

const uncovered = [...allowedSet].filter((t) => !proseSet.has(t) && !neutralSet.has(t));
check(
  "every allowed field type is classified as prose or language-neutral",
  uncovered.length === 0,
  uncovered.length
    ? `unclassified: ${uncovered.join(", ")} — add each to PROSE_FIELD_TYPES or\n` +
      `       LANGUAGE_NEUTRAL_FIELD_TYPES in contract/manifest.ts. A new type that is\n` +
      `       in neither list silently escapes the multi-language rule.`
    : ""
);

const phantom = [...proseSet, ...neutralSet].filter((t) => !allowedSet.has(t));
check(
  "no classification names a field type that does not exist",
  phantom.length === 0,
  phantom.length ? `not in ALLOWED_TABLE_FIELD_TYPES: ${phantom.join(", ")}` : ""
);

/**
 * Which shipped fields violate the rule — checked directly on the manifests so
 * the failure names the file and the field, not just "a manifest is bad".
 *
 * `isProseFieldType` is imported rather than re-derived here: this is the third
 * place that needs the same answer, and a third copy of the rule would drift.
 */
const langOffenders = [];
let langTablesChecked = 0;
for (const dir of ["content/themes", "content/plugins"]) {
  for (const f of walk(join(ROOT, dir), [".json"])) {
    if (!f.endsWith("theme.json") && !f.endsWith("plugin.json")) continue;
    let manifest;
    try {
      manifest = JSON.parse(read(f));
    } catch {
      continue;
    }
    for (const t of manifest.tables ?? []) {
      langTablesChecked++;
      const declared = new Set((t.translatable ?? []).map(String));
      for (const field of t.fields ?? []) {
        const key = String(field?.key ?? "");
        const type = String(field?.type ?? "text");
        const prose = isProseFieldType(type);
        if (prose && !declared.has(key)) {
          langOffenders.push(`${rel(f)}: table ${t.name}, field "${key}" (${type}) is not in translatable`);
        }
        if (!prose && declared.has(key)) {
          langOffenders.push(`${rel(f)}: table ${t.name}, field "${key}" (${type}) is wrongly marked translatable`);
        }
      }
    }
  }
}

// Non-vacuity: a check that iterated zero tables would pass while proving
// nothing. Fail loudly instead, so a rename that hides the manifests from this
// walk is caught rather than celebrated.
check(
  "the multi-language check actually saw some declared tables",
  langTablesChecked > 0,
  langTablesChecked === 0
    ? `walked themes/ and plugins/ and found no manifest with a tables[] block.\n` +
      `       Either every extension dropped its tables, or this check is now\n` +
      `       looking in the wrong place — both need a human.`
    : ""
);

check(
  "shipped themes declare translatable exactly for prose fields",
  langOffenders.length === 0,
  langOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Extension entry points exist");
// ---------------------------------------------------------------------------

/**
 * A manifest that points at a missing file fails at activation, in production,
 * with the site already switched over. Checking the file exists is cheap and
 * turns that into a caught mistake.
 */
const themeRoot = join(ROOT, "content", "themes");
const themeDirs = existsSync(themeRoot)
  ? readdirSync(themeRoot).filter((d) => statSync(join(themeRoot, d)).isDirectory())
  : [];

const entryProblems = [];
for (const name of themeDirs) {
  const manifestPath = join(themeRoot, name, "theme.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch {
    continue; // already reported above
  }
  if (manifest.runtime === "worker") {
    const entry = String(manifest.entry ?? "worker.js");
    if (!existsSync(join(themeRoot, name, entry))) {
      entryProblems.push(`content/themes/${name}: runtime=worker but ${entry} is missing`);
    }
  }
}

const pluginRoot = join(ROOT, "content", "plugins");
const pluginDirs = existsSync(pluginRoot)
  ? readdirSync(pluginRoot).filter((d) => statSync(join(pluginRoot, d)).isDirectory())
  : [];
for (const name of pluginDirs) {
  const manifestPath = join(pluginRoot, name, "plugin.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch (e) {
    entryProblems.push(`plugins/${name}/plugin.json: invalid JSON (${e.message})`);
    continue;
  }
  if (!manifest.name) entryProblems.push(`plugins/${name}: manifest has no "name"`);
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  if (hooks.length === 0 && manifest.runtime !== "declarative") {
    // Not an error — a plugin may register nothing yet — but the manifest must
    // still be self-describing.
  }
}

check(
  "worker-runtime themes ship the entry file they declare",
  entryProblems.length === 0,
  entryProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Declared admin menus are renderable (batch 3)");
// ---------------------------------------------------------------------------

/**
 * A manifest's `adminMenus[].screen` is the only thing that decides which admin
 * page opens. An unknown value does not fail the install — it produces a
 * sidebar entry that leads to a "no renderer for this screen type" panel, and
 * nothing points back at the manifest. So the shipped extensions are checked
 * against the same list the validator uses.
 *
 * The list is read out of `contract/manifest.ts` rather than copied, and then
 * compared against a pinned set. Copying it would let the two drift; not
 * pinning it would let someone "fix" a failure by adding a screen nobody
 * implements.
 */
const manifestSrc = read(join(ROOT, "src/extensions/contract/manifest.ts"));
const allowedBlock = manifestSrc.match(/const ALLOWED_ADMIN_SCREENS\s*=\s*\[([\s\S]*?)\]/);
const allowedScreens = allowedBlock
  ? [...allowedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
const EXPECTED_SCREENS = [
  "dashboard", "content-list", "content-edit", "settings", "media", "custom",
  "theme-settings", "plugin-settings", "table-list", "table-edit", "features",
];

/** The switch keys the platform ships. Pinned so deleting or renaming one is a
 *  deliberate edit here rather than a silent removal from the admin. */
const FEATURE_SWITCH_KEYS_EXPECTED = ["cache_mirror_kv", "theme_runtime_worker", "ui_locale_follow_site"];
check(
  "ALLOWED_ADMIN_SCREENS contains exactly the pinned set",
  JSON.stringify([...allowedScreens].sort()) === JSON.stringify([...EXPECTED_SCREENS].sort()),
  `implementation: ${JSON.stringify(allowedScreens)}\n       pinned:         ${JSON.stringify(EXPECTED_SCREENS)}`
);

/**
 * The feature-switch vocabulary has exactly one definition, and it is in
 * `shared/features.ts`.
 *
 * It lives in `shared/` and not in `contract/manifest.ts` because
 * `shared/cache.ts` consumes one of the switches and `shared/` is a leaf that
 * may not import `extensions/` (§7.3 rule 5) — the layering check above failed
 * when the vocabulary was first put in `manifest.ts`, which is what caught it.
 *
 * A re-export from `manifest.ts` was tried and removed: it typechecked, but
 * Node loads `manifest.ts` as plain ESM in this suite, and a *value* re-export
 * needs an explicit `.ts` extension that `tsc` in turn rejects without
 * `allowImportingTsExtensions`. Two constraints pointing opposite ways is a
 * signal the extra hop was not wanted — importers go straight to the source.
 *
 * The guard is therefore: the array is defined in exactly one file, that file
 * is the leaf, and nothing else defines a second copy.
 */
const featuresSrc = read(join(ROOT, "src/shared/features.ts"));
const switchDefs = [...walk(join(ROOT, "src"), [".ts"])].filter((f) =>
  /export\s+const\s+FEATURE_SWITCHES\s*(?::[^=]*)?=\s*\[/.test(read(f))
);
check(
  "FEATURE_SWITCHES is defined in exactly one file",
  switchDefs.length === 1 && rel(switchDefs[0]) === "src/shared/features.ts",
  switchDefs.length
    ? `defined in: ${switchDefs.map(rel).join(", ")}`
    : "no definition found — the switch vocabulary has gone missing"
);
check(
  "the switch vocabulary lives in the leaf layer, not in contract/",
  !/FEATURE_SWITCHES/.test(manifestSrc),
  "contract/manifest.ts mentions the switches — it must not own or re-export them"
);

// Every switch must carry all four fields, and the defaults must be explicit
// booleans. A missing `defaultOn` would read as `undefined` -> falsy, which
// happens to be the intended default today and would silently become "on" for
// a future switch whose author forgot the field.
const declaredSwitches = [...featuresSrc.matchAll(/\{\s*key:\s*"([a-z0-9_]+)",[\s\S]*?defaultOn:\s*(true|false),/g)]
  .map((m) => ({ key: m[1], defaultOn: m[2] === "true" }));
check(
  "every declared feature switch states its default explicitly",
  declaredSwitches.length === FEATURE_SWITCH_KEYS_EXPECTED.length,
  `parsed ${declaredSwitches.length} of ${FEATURE_SWITCH_KEYS_EXPECTED.length}: ${declaredSwitches.map((s) => s.key).join(", ")}`
);
check(
  "every switch defaults to off",
  declaredSwitches.length > 0 && declaredSwitches.every((s) => s.defaultOn === false),
  declaredSwitches.filter((s) => s.defaultOn).map((s) => `${s.key}=on`).join(", ")
);
check(
  "declared switch keys match the expected set",
  JSON.stringify(declaredSwitches.map((s) => s.key).sort()) ===
    JSON.stringify([...FEATURE_SWITCH_KEYS_EXPECTED].sort()),
  `implementation: ${JSON.stringify(declaredSwitches.map((s) => s.key))}\n       expected:      ${JSON.stringify(FEATURE_SWITCH_KEYS_EXPECTED)}`
);

// The `varName` in each switch must be a name the runtime can actually read
// off `Env`. `types.ts` spells them out (an interface cannot be derived from
// data), so the two are cross-checked here — a rename on one side only would
// otherwise leave a switch whose deploy-time fallback silently never applies.
const envSrc = read(join(ROOT, "src/shared/types.ts"));
const varNames = [...featuresSrc.matchAll(/varName:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
const undeclaredVars = varNames.filter(
  (v) => !new RegExp(`\\b${v}\\??:\\s*string`).test(envSrc)
);
check(
  "every switch varName is declared on the Env interface",
  varNames.length > 0 && undeclaredVars.length === 0,
  undeclaredVars.map((v) => `${v} is not declared in src/shared/types.ts`).join("\n       ")
);

// ...and the *same* name must exist in `wrangler.jsonc` `vars`, because that is
// the deploy-time layer an operator actually edits. Declaring the var on `Env`
// only makes it *readable*; a switch whose var is absent from the config has no
// deploy-time fallback at all, and the failure is invisible — `undefined` and
// `"false"` both resolve to off, so the deploy looks correct until someone sets
// a var and nothing happens. Checked in both directions: a name in the config
// that no switch declares is a leftover from a rename, and it silently becomes
// a var nothing reads.
//
// ⚠️ `wrangler.local.jsonc` (the real-ids copy used for every command, and the
// one whose `vars` block actually ships) is gitignored and cannot be asserted
// from here; its structural parity with this file is enforced by
// `tests/tools/_config-parity.mjs` instead.
const wranglerSrc = read(join(ROOT, "wrangler.jsonc"))
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
let declaredVars = null;
try { declaredVars = JSON.parse(wranglerSrc).vars ?? null; } catch { declaredVars = null; }
const varKeys = declaredVars && typeof declaredVars === "object" ? Object.keys(declaredVars) : [];
check(
  "wrangler.jsonc declares a vars block",
  declaredVars !== null && varKeys.length > 0,
  declaredVars === null ? "unparseable or missing" : `vars has ${varKeys.length} key(s)`
);
const varsMissingFromConfig = varNames.filter((v) => !varKeys.includes(v));
check(
  "every switch varName is declared in wrangler.jsonc vars",
  varsMissingFromConfig.length === 0,
  varsMissingFromConfig.map((v) => `${v} is declared on Env but absent from wrangler.jsonc vars`).join("\n       ")
);
const configVarsWithoutSwitch = varKeys.filter((v) => !varNames.includes(v));
check(
  "wrangler.jsonc declares no var that no switch reads",
  configVarsWithoutSwitch.length === 0,
  configVarsWithoutSwitch.map((v) => `${v} is in wrangler.jsonc vars but no switch declares it`).join("\n       ")
);

const TABLE_SCREENS = ["table-list", "table-edit"];
const menuProblems = [];
for (const [kind, dir] of [["theme", "content/themes"], ["plugin", "content/plugins"]]) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const manifestPath = join(base, name, kind === "theme" ? "theme.json" : "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    const declaredTables = new Set(
      (Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? ""))
    );
    // Pages this plugin declared. A `plugin-page:<id>` menu that names an id
    // which is not here opens a screen with nothing to render — the menu entry
    // looks fine in the sidebar and the page behind it is blank, which reads as
    // a load failure rather than a manifest typo. Rule 50.
    const declaredPages = new Set(
      (Array.isArray(manifest.adminPages) ? manifest.adminPages : []).map((p) => String(p?.id ?? ""))
    );
    for (const menu of Array.isArray(manifest.adminMenus) ? manifest.adminMenus : []) {
      const where = `${dir}/${name}: menu "${menu?.id}"`;
      const screen = String(menu?.screen ?? "");
      if (screen.startsWith(PLUGIN_PAGE_SCREEN_PREFIX)) {
        const pageId = screen.slice(PLUGIN_PAGE_SCREEN_PREFIX.length);
        if (!pageId) menuProblems.push(`${where} uses "${screen}" with no page id`);
        else if (!declaredPages.has(pageId)) {
          menuProblems.push(
            `${where} opens page "${pageId}", which is not in its adminPages[] (${[...declaredPages].join(", ") || "none declared"})`
          );
        }
        continue;
      }
      if (!allowedScreens.includes(screen)) {
        menuProblems.push(`${where} uses unknown screen "${screen}"`);
        continue;
      }
      if (TABLE_SCREENS.includes(screen)) {
        const table = String(menu?.args?.table ?? "");
        if (!table) menuProblems.push(`${where} screen "${screen}" has no args.table`);
        else if (!declaredTables.has(table)) {
          menuProblems.push(`${where} references table "${table}" which is not in its tables[]`);
        }
      }
      if (screen === "custom" && !String(menu?.args?.view ?? "")) {
        menuProblems.push(`${where} screen "custom" has no args.view`);
      }
    }
  }
}
check(
  "every shipped admin menu uses a known screen and names a real table",
  menuProblems.length === 0,
  menuProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Plugins declare data, not code (§10 rule 48)");
// ---------------------------------------------------------------------------

/**
 * A plugin may not ship executable code. This is the rule that makes the whole
 * no-build design honest: a Workers runtime forbids `eval` / `new Function` /
 * dynamic `import` of user code, so a plugin that "runs" can only be one whose
 * behaviour the host performs on its behalf.
 *
 * Two things would break it:
 *
 *   * a `.js`/`.mjs`/`.ts` file inside a shipped plugin directory — even unused,
 *     its presence says "you may load this", and the next change loads it;
 *   * a manifest key that names code (`entry`, `entryFile`, `handler`, `main`,
 *     `script`) — the reference implementation had both `entry` and `entryFile`
 *     for the same idea, which is two authorities for one fact.
 *
 * The check is on shipped directories, not on the contract type: a manifest
 * arriving as a zip is validated by `validation.ts` (which has the same list),
 * and this covers the ones in the repo that a reader would copy from.
 */
const CODE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx"];
const CODE_KEYS = ["entry", "entryFile", "handler", "main", "script", "activate", "deactivate"];
const pluginCodeProblems = [];
{
  const pluginBase = join(ROOT, "content", "plugins");
  if (existsSync(pluginBase)) {
    for (const name of readdirSync(pluginBase)) {
      const dir = join(pluginBase, name);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      for (const f of walk(dir, CODE_EXTENSIONS)) {
        pluginCodeProblems.push(`plugins/${name}/${relative(dir, f).split(sep).join("/")} is executable code`);
      }
      const manifestPath = join(dir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
      for (const key of CODE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(manifest, key)) {
          pluginCodeProblems.push(
            `plugins/${name}/plugin.json declares "${key}" — a plugin declares data, and the host performs the behaviour`
          );
        }
      }
    }
  }
}
check(
  "no shipped plugin ships executable code or a code-bearing manifest key",
  pluginCodeProblems.length === 0,
  pluginCodeProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Declared plugin pages are renderable (§10 rule 49)");
// ---------------------------------------------------------------------------

/**
 * Every `adminPages[].blocks[].type` must have a renderer in the admin SPA.
 * A block type with no renderer draws nothing where content was promised — a
 * blank screen at HTTP 200, which is the same shape of failure as a template
 * slot that never fills.
 *
 * The SPA is plain ESM with no build step, so the renderer list is a switch in
 * `public/admin/js/plugin-page.js`. Rather than parsing that switch (a
 * structure that could be written several ways), the module exports the list it
 * renders — one authority, and the check is a set comparison.
 */
const pageBlockProblems = [];
{
  const pinnedBlocks = ["table", "stats", "form"];
  check(
    "ALLOWED_PAGE_BLOCKS contains exactly the pinned set",
    JSON.stringify([...ALLOWED_PAGE_BLOCKS].sort()) === JSON.stringify([...pinnedBlocks].sort()),
    `implementation: ${JSON.stringify([...ALLOWED_PAGE_BLOCKS])}\n       pinned:         ${JSON.stringify(pinnedBlocks)}`
  );

  const rendererPath = join(ROOT, "public", "admin", "js", "plugin-page.js");
  if (!existsSync(rendererPath)) {
    pageBlockProblems.push("public/admin/js/plugin-page.js does not exist");
  } else {
    const src = read(rendererPath);
    const match = src.match(/export const RENDERED_BLOCK_TYPES\s*=\s*\[([\s\S]*?)\]/);
    const rendered = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!rendered.length) {
      pageBlockProblems.push(
        "plugin-page.js does not export RENDERED_BLOCK_TYPES — the guard cannot tell what it renders"
      );
    } else if (JSON.stringify([...rendered].sort()) !== JSON.stringify([...ALLOWED_PAGE_BLOCKS].sort())) {
      pageBlockProblems.push(
        `renderer/contract mismatch — contract: ${JSON.stringify([...ALLOWED_PAGE_BLOCKS])}, renderer: ${JSON.stringify(rendered)}`
      );
    }

    // The `stats` aggregate list is a second closed set with the same failure
    // shape: the validator refuses a name the renderer cannot draw, and the
    // renderer draws a name the server cannot compute. All three read
    // `ALLOWED_AGGREGATES`; this compares the renderer's exported copy so a
    // one-sided edit fails here instead of shipping a "cannot compute" panel.
    const aggMatch = src.match(/export const RENDERED_AGGREGATES\s*=\s*\[([\s\S]*?)\]/);
    const renderedAgg = aggMatch ? [...aggMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!renderedAgg.length) {
      pageBlockProblems.push(
        "plugin-page.js does not export RENDERED_AGGREGATES — the guard cannot tell what aggregates it draws"
      );
    } else if (JSON.stringify([...renderedAgg].sort()) !== JSON.stringify([...ALLOWED_AGGREGATES].sort())) {
      pageBlockProblems.push(
        `aggregate mismatch — contract: ${JSON.stringify([...ALLOWED_AGGREGATES])}, renderer: ${JSON.stringify(renderedAgg)}`
      );
    }
  }

  // And every shipped page may only use block types the contract knows.
  for (const name of existsSync(join(ROOT, "content", "plugins")) ? readdirSync(join(ROOT, "content", "plugins")) : []) {
    const manifestPath = join(ROOT, "content", "plugins", name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    const tables = new Set((Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? "")));
    // The declared numeric fields, so a shipped `sum` can be checked against a
    // column that actually exists and is summable — the same two conditions the
    // server-side `tableAggregate` enforces before it will run a query.
    const numericFields = new Set();
    for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
      for (const f of Array.isArray(t?.fields) ? t.fields : []) {
        if (String(f?.type ?? "") === "number") numericFields.add(`${String(t?.name ?? "")}.${String(f?.key ?? "")}`);
      }
    }
    for (const page of Array.isArray(manifest.adminPages) ? manifest.adminPages : []) {
      for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
        const where = `plugins/${name}: page "${page?.id}" block`;
        const type = String(block?.type ?? "");
        if (!(ALLOWED_PAGE_BLOCKS).includes(type)) {
          pageBlockProblems.push(`${where} has unknown type "${type}"`);
        }
        // A block that reads a table must name one of *its own* tables.
        if (type === "table" || type === "stats" || type === "form") {
          const source = String(block?.source ?? "");
          if (!source) pageBlockProblems.push(`${where} ("${type}") has no source`);
          else if (!tables.has(source)) {
            pageBlockProblems.push(`${where} reads table "${source}", which is not in its tables[]`);
          }
        }
        // A shipped `stats` must name an aggregate the host computes, and a
        // `sum` must point at a declared numeric column.
        if (type === "stats") {
          const agg = String(block?.aggregate ?? "count");
          if (!(ALLOWED_AGGREGATES).includes(agg)) {
            pageBlockProblems.push(`${where} has unknown aggregate "${agg}"`);
          }
          if (agg === "sum") {
            const field = String(block?.field ?? "");
            if (!field) pageBlockProblems.push(`${where} sums with no field`);
            else if (!numericFields.has(`${String(block?.source ?? "")}.${field}`)) {
              pageBlockProblems.push(`${where} sums "${field}", which is not a declared numeric field`);
            }
          }
        }
      }
    }
  }
}
check(
  "every page block type has a renderer, and every shipped block is renderable",
  pageBlockProblems.length === 0,
  pageBlockProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Channel declarations match the host (§10 rule 51)");
// ---------------------------------------------------------------------------

/**
 * A channel declaration has two halves that must agree with the host:
 *
 *   * `code` must be one the host implements. Declaring an unimplemented
 *     channel puts a selectable option in the admin that fails at send time.
 *   * every `configSchema[].type` must have an admin control. The settings form
 *     is generated from the schema, so an unrenderable type makes an empty
 *     input that looks like a data problem rather than a manifest one.
 *
 * The control list lives in `public/admin/js/plugin-page.js`, which exports it
 * for the same reason the block renderer exports its list: a guard that parses
 * a switch statement is guessing at structure it could just be told.
 */
const channelProblems = [];
{
  const pinnedTypes = ["text", "password", "url", "number", "boolean"];
  check(
    "ALLOWED_CHANNEL_FIELD_TYPES contains exactly the pinned set",
    JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES].sort()) === JSON.stringify([...pinnedTypes].sort()),
    `implementation: ${JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES])}\n       pinned:         ${JSON.stringify(pinnedTypes)}`
  );

  const pageJsPath = join(ROOT, "public", "admin", "js", "plugin-page.js");
  let controlled = [];
  if (!existsSync(pageJsPath)) {
    channelProblems.push("public/admin/js/plugin-page.js does not exist");
  } else {
    const src = read(pageJsPath);
    const match = src.match(/export const RENDERED_CHANNEL_FIELD_TYPES\s*=\s*\[([\s\S]*?)\]/);
    controlled = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!controlled.length) {
      channelProblems.push("plugin-page.js does not export RENDERED_CHANNEL_FIELD_TYPES");
    } else if (JSON.stringify([...controlled].sort()) !== JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES].sort())) {
      channelProblems.push(
        `control/contract mismatch — contract: ${JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES])}, controls: ${JSON.stringify(controlled)}`
      );
    }
  }

  for (const name of existsSync(join(ROOT, "content", "plugins")) ? readdirSync(join(ROOT, "content", "plugins")) : []) {
    const manifestPath = join(ROOT, "content", "plugins", name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    for (const ch of Array.isArray(manifest.channels) ? manifest.channels : []) {
      const where = `plugins/${name}: channel "${ch?.code}"`;
      if (!(HOST_CHANNEL_CODES).includes(String(ch?.code ?? ""))) {
        channelProblems.push(`${where} is not implemented by the host (${HOST_CHANNEL_CODES.join(", ")})`);
      }
      for (const field of Array.isArray(ch?.configSchema) ? ch.configSchema : []) {
        const type = String(field?.type ?? "");
        if (!(ALLOWED_CHANNEL_FIELD_TYPES).includes(type)) {
          channelProblems.push(`${where} field "${field?.key}" has unknown type "${type}"`);
        }
      }
    }
  }
}
check(
  "every declared channel and config field matches what the host implements",
  channelProblems.length === 0,
  channelProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("The retired menu table stays retired");
// ---------------------------------------------------------------------------

/**
 * 0012 moved theme menus into `admin_menu_registry` and dropped
 * `theme_admin_menus`. Two things would quietly undo that:
 *
 *   * source code still reading or writing the old table — the new registry
 *     would fill up while a stale reader returned an empty list, which looks
 *     exactly like "the theme declared no menus";
 *   * a later migration re-creating it, which would leave two tables holding
 *     the same thing again.
 *
 * A text scan is the right shape here: this is a *name* that must not appear,
 * not a structure to be parsed. Comments are stripped first — prose *about*
 * the retirement ("0012 moved rows out of theme_admin_menus") is documentation,
 * not a reader of the table, and punishing it would push the next person to
 * delete the explanation.
 */
const RETIRED = "theme_admin_menus";
const withoutComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const retiredOffenders = [];
for (const f of walk(join(ROOT, "src"), [".ts"])) {
  if (withoutComments(read(f)).includes(RETIRED)) retiredOffenders.push(`${rel(f)} still references ${RETIRED}`);
}
const migrationsRoot = join(ROOT, "content", "migrations");
const laterMigrations = readdirSync(migrationsRoot)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .filter((f) => Number(f.split("_")[0]) > 12)
  .filter((f) => withoutComments(read(join(migrationsRoot, f))).includes(RETIRED));
for (const f of laterMigrations) {
  retiredOffenders.push(`content/migrations/${f} references ${RETIRED} after 0012 retired it`);
}
check(
  "no source file or later migration uses the dropped menu table",
  retiredOffenders.length === 0,
  retiredOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
// The hook contract and the hook implementation must name the same hooks
// ---------------------------------------------------------------------------
//
// `DECLARABLE_HOOKS` is what a plugin manifest may declare; `HOOK_IMPLS` is what
// the host actually supplies. They live in different files on purpose (the
// contract may not import the implementation), which is exactly why they need a
// guard: the list is what the manifest validator checks against, so a hook that
// exists in the implementation but not in the list is undeclarable, and one in
// the list but not the implementation is a typo trap — the validator accepts it
// and the runtime silently drops it.
{
  const hooksSrc = read(join(ROOT, "src/extensions/contract/hooks.ts"));
  const implSrc = read(join(ROOT, "src/extensions/plugin/runtime.ts"));

  const declaredBlock = hooksSrc.match(/export const DECLARABLE_HOOKS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const declaredHooks = declaredBlock ? [...declaredBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  // `HOOK_IMPLS` is an object literal; take its top-level keys, which are the
  // hook names the host can attach.
  const implBlock = implSrc.match(/const HOOK_IMPLS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const implHooks = implBlock ? [...implBlock[1].matchAll(/^  ([A-Za-z][A-Za-z0-9_]*):\s*\{/gm)].map((m) => m[1]) : [];

  // Both halves must be non-empty, or the comparison below passes vacuously.
  check(
    "hook lists were actually parsed (guards against an empty-set pass)",
    declaredHooks.length > 0 && implHooks.length > 0,
    `DECLARABLE_HOOKS=${declaredHooks.length} entries, HOOK_IMPLS=${implHooks.length} entries`
  );
  check(
    "every declarable hook is implemented, and every implementation is declarable",
    JSON.stringify([...declaredHooks].sort()) === JSON.stringify([...implHooks].sort()),
    `declarable:     ${JSON.stringify([...declaredHooks].sort())}\n       implemented:    ${JSON.stringify([...implHooks].sort())}`
  );
}

// ---------------------------------------------------------------------------
section("The domain event contract is coherent (§10 rule 45)");
// ---------------------------------------------------------------------------

/**
 * `events.ts` declares *what happened*; `hooks.ts` declares *where you may
 * attach*. Both are contracts, so both need the same treatment as the hook
 * list above: parsed from source, compared against a pinned set, and checked
 * for non-vacuity before anything is asserted about the set.
 *
 * These are read out of the file rather than imported for the same reason the
 * hook guard does it: the file may not import the implementation, and the
 * architecture suite is deliberately dependency-free (it must run first, with
 * no build step, on a bare checkout).
 */
{
  const eventsSrc = read(join(ROOT, "src/extensions/contract/events.ts"));
  const hooksSrc = read(join(ROOT, "src/extensions/contract/hooks.ts"));

  const eventsBlock = eventsSrc.match(/export const DOMAIN_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const events = eventsBlock ? [...eventsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  const scopedBlock = eventsSrc.match(/export const LOCALE_SCOPED_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const scoped = scopedBlock ? [...scopedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  // Non-vacuity first: every assertion below is a statement about a set, and a
  // set that failed to parse is trivially "consistent".
  check(
    "the event contract was actually parsed (non-vacuity)",
    events.length > 0 && scoped.length > 0,
    `DOMAIN_EVENTS=${events.length} entries, LOCALE_SCOPED_EVENTS=${scoped.length} entries`
  );

  const dupes = events.filter((e, i) => events.indexOf(e) !== i);
  checkEmpty(
    "no domain event is declared twice",
    dupes
  );

  // Naming is the contract's readability: a reader of `PostPublished` knows it
  // already happened, where `savePost` leaves them guessing before-or-after.
  const badlyNamed = events.filter((e) => !/^[A-Z][A-Za-z0-9]*$/.test(e));
  checkEmpty(
    "every domain event is PascalCase, past tense by convention",
    badlyNamed
  );

  // A subscription target that is not an event is the `beforRender` typo again:
  // the validator accepts it, and the hook never fires.
  const scopedNotEvents = scoped.filter((e) => !events.includes(e));
  checkEmpty(
    "every locale-scoped event is a declared domain event",
    scopedNotEvents
  );

  const scopedDupes = scoped.filter((e, i) => scoped.indexOf(e) !== i);
  checkEmpty(
    "no locale-scoped event is listed twice",
    scopedDupes
  );

  // Payload versioning must be *total*: every event resolves to a version even
  // when the override map is empty. `payloadVersionOf` falls back to 1, so the
  // guard checks the fallback path is real by looking for the `?? 1`.
  const versionFn = eventsSrc.match(/export function payloadVersionOf[\s\S]*?\n\}/);
  check(
    "payloadVersionOf has a total fallback (an event with no override still has a version)",
    Boolean(versionFn) && /\?\?\s*1\b/.test(versionFn[0]),
    versionFn ? versionFn[0].replace(/\s+/g, " ").slice(0, 120) : "payloadVersionOf not found"
  );

  // Events live above hooks, not beside them. Collapsing the two is how a CMS
  // gets a `save_post` that means six things — so the file must say so, and the
  // hook list must not have quietly grown event names.
  const hooksLookingLikeEvents = declaredHooksForEvents(hooksSrc).filter((h) => events.includes(h));
  checkEmpty(
    "no domain event is smuggled into the hook list",
    hooksLookingLikeEvents
  );

  // Every event that carries a language must be one whose fact *is* a
  // language-specific statement. `SiteCreated` has no locale; `PostPublished`
  // does. This is a sanity bound rather than a proof — it catches the case
  // where someone marks a site-level fact as locale-scoped by accident.
  const SITE_LEVEL_EVENTS = [
    "SiteCreated", "SiteDeleted", "ExtensionInstalled", "ExtensionEnabled",
    "ExtensionDisabled", "ThemeActivated", "ThemeDeactivated",
    "UserCreated", "UserPasswordChanged", "UserDeleted", "MediaUploaded", "MediaDeleted",
  ];
  const misScoped = scoped.filter((e) => SITE_LEVEL_EVENTS.includes(e));
  checkEmpty(
    "site-level facts are not marked locale-scoped",
    misScoped
  );
}

/** Hook names declared in `hooks.ts`, for the cross-check above. */
function declaredHooksForEvents(src) {
  const block = src.match(/export const DECLARABLE_HOOKS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

// ---------------------------------------------------------------------------
section("Multilingual and URL rules (AGENTS.md 56-59)");
// ---------------------------------------------------------------------------

// Rules 56-59 exist because every layer of i18n has a spelling that fails
// *silently*: a hand-rolled locale regex drifts from the one definition, a
// `|| "en"` fallback makes a zh-CN site read English rows at 200 OK, a slug
// filter without COALESCE 404s every language that named its own slug while
// the default language works fine, and a site-blind SEO endpoint serves
// site A's sitemap on site B's host. Each guard below scans with comments
// blanked and each scan is paired with a non-vacuity check, per §12.

{
  const srcDir = join(ROOT, "src");
  const files = walk(srcDir, [".ts"]);
  const blanked = files.map((f) => ({
    path: relative(ROOT, f).split(sep).join("/"),
    src: blankComments(read(f)),
  }));

  // -- Rule 56: the locale-segment matcher is defined exactly once ----------
  // The BCP-47-ish shape is the fingerprint of "I am parsing a locale off a
  // path". resolve.ts owns it; a second copy is a second policy that will
  // disagree with the first.
  const segRe = /\[\s*a-z\s*\]\s*\{\s*2\s*\}\s*\(\s*\?:\s*-\s*\[A-Za-z\]\s*\{\s*2\s*\}\s*\)\s*\?/;
  const segOwners = blanked.filter((f) => f.path.startsWith("src/platform/i18n/") === false && segRe.test(f.src));
  checkEmpty("the locale-segment matcher lives only in platform/i18n (rule 56)", segOwners.map((f) => f.path));
  check(
    "rule 56 scan actually saw resolve.ts (non-vacuity)",
    blanked.some((f) => f.path.replace(/\\/g, "/") === "src/platform/i18n/resolve.ts") &&
      segRe.test(blankComments(read(join(ROOT, "src/platform/i18n/resolve.ts"))))
  );

  // -- Rule 57: no hardcoded locale fallbacks outside the i18n layer --------
  // `|| "en"` reads as "the caller forgot the locale" and answers with a
  // literal. The blessed path is resolveContentLocale / defaultLocale, both
  // site-scoped; anything else freezes one language into the code.
  const fallbackRe = /(\|\||\?\?)\s*["'](en|zh(?:-CN)?|ja|ko|fr|de|es|pt(?:-BR)?)["']/g;
  const fallbackers = blanked
    .filter((f) => !f.path.startsWith("src/platform/i18n/"))
    .map((f) => ({ path: f.path, hits: [...f.src.matchAll(fallbackRe)].length }))
    .filter((f) => f.hits > 0);
  checkEmpty("no hardcoded locale fallbacks outside platform/i18n (rule 57)", fallbackers.map((f) => `${f.path} (${f.hits})`));

  // -- Rule 58: slug filters across the translations join are COALESCE'd ----
  // Every statement that joins post_translations and filters on p.slug must
  // read COALESCE(t.slug, p.slug) — the per-language URL segment wins, the
  // main-table slug is the fallback. A bare `p.slug = ?` 404s every language
  // that named its own slug.
  const stmtRe = /`[^`]*FROM posts p\s*JOIN post_translations[^`]*`/g;
  const slugStmts = [];
  for (const f of blanked) {
    for (const m of f.src.matchAll(stmtRe)) {
      const stmt = m[0];
      if (/(?:AND|WHERE)\s+p\.slug\s*=/i.test(stmt) && !stmt.includes("COALESCE")) {
        slugStmts.push(`${f.path}: ${stmt.slice(0, 60)}…`);
      }
    }
  }
  checkEmpty("every posts⋈translations slug filter is COALESCE'd (rule 58)", slugStmts);
  // Non-vacuity: the scan must be seeing the real join sites (there are at
  // least four on disk: findContent, the front router's single lookup, the
  // theme query, and the Worker theme's API). If this drops, the statement
  // regex has stopped matching and rule 58 is unguarded.
  const joinCount = blanked.reduce((n, f) => n + [...f.src.matchAll(stmtRe)].length, 0);
  check(
    "rule 58 scan actually saw the join sites (non-vacuity)",
    joinCount >= 3,
    `found ${joinCount} posts⋈translations statements`
  );

  // -- Rule 59: SEO endpoints are site-scoped -------------------------------
  // sitemap/robots/feed each take siteId and use it. A function that "forgot"
  // the parameter compiles fine and serves the default site on every host —
  // exactly the bug the SEO endpoints already had once.
  const seoSrc = blankComments(read(join(ROOT, "src/platform/seo.ts")));
  const exports = [...seoSrc.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)];
  const siteBlind = exports
    .filter(([, , params]) => !/\bsiteId\b/.test(params))
    .map(([, name]) => name);
  checkEmpty("every exported seo.ts function takes siteId (rule 59)", siteBlind);
  check(
    "rule 59 scan actually saw the SEO exports (non-vacuity)",
    exports.length >= 3,
    `found ${exports.length} exported functions`
  );
}

// ---------------------------------------------------------------------------
section("The editor palette comes from the renderer (one definition)");
// ---------------------------------------------------------------------------

// The insertable block set lives in `CORE_BLOCKS` (rendering/blocks.ts) and
// reaches the editor through `GET /api/v1/blocks`. A block-name literal in the
// SPA is a second list guaranteed to drift — the hand-written palette had
// already dropped gallery, button and columns while the renderer kept
// supporting them, and nothing failed because both sides were green.
{
  const blockNameRe = /["'`]core\/(?:paragraph|heading|list|quote|code|image|gallery|button|separator|html|group|columns)["'`]/;
  const spaFiles = walk(join(ROOT, "public", "admin"), [".js"]);
  const offenders = spaFiles
    .filter((f) => blockNameRe.test(blankComments(read(f))))
    .map((f) => relative(ROOT, f).split(sep).join("/"));
  checkEmpty("the admin SPA carries no block-name literals (palette comes from CORE_BLOCKS)", offenders);
  check(
    "palette scan actually saw the SPA (non-vacuity)",
    spaFiles.length >= 15,
    `scanned ${spaFiles.length} js files`
  );
  check(
    "the renderer's CORE_BLOCKS is the source being scanned for (non-vacuity)",
    Array.isArray(CORE_BLOCKS) && CORE_BLOCKS.length >= 12 && CORE_BLOCKS.every((b) => blockNameRe.test(`"${b.name}"`)),
    `CORE_BLOCKS has ${Array.isArray(CORE_BLOCKS) ? CORE_BLOCKS.length : 0} entries`
  );
}

// ---------------------------------------------------------------------------
section("Dashboard stat cards arrive as data (one definition)");
// ---------------------------------------------------------------------------

// The dashboard's stat cards are produced by the API — labels from the UI
// dictionary, values from site-scoped counts, extendable by plugins through
// the `dashboardCards` filter. A `stat("Posts", …)` literal in the screen is
// a client-side copy that will not translate and will not see plugin cards.
{
  const dash = join(ROOT, "public", "admin", "js", "screens", "dashboard.js");
  const statLiteralRe = /stat\(\s*["'](Posts|Pages|Media|Drafts)["']/;
  const hasLiteral = statLiteralRe.test(blankComments(read(dash)));
  checkEmpty("the dashboard screen carries no hard-coded stat cards", hasLiteral ? ["dashboard.js stat(\"Posts|Pages|Media|Drafts\")"] : []);
  // Non-vacuity: the scan must be looking at the screen that renders cards.
  check(
    "dashboard scan actually saw the cards renderer (non-vacuity)",
    /d\.cards/.test(blankComments(read(dash)))
  );
}

// ---------------------------------------------------------------------------
section("The declarative settings form covers every declared field type");
// ---------------------------------------------------------------------------

// `settings[]` entries may declare any of `ALLOWED_FIELD_TYPES` — the same
// closed set the manifest validator enforces. The one auto-form that renders
// them (theme-menu.js, for themes AND plugins) must have a branch per type:
// a type without a branch silently degrades to a text input, which is how a
// declared select loses its choices and a declared boolean becomes free text.
{
  const form = blankComments(read(join(ROOT, "public", "admin", "js", "screens", "theme-menu.js")));
  const missing = ALLOWED_FIELD_TYPES.filter((t) => !form.includes(`case "${t}"`));
  checkEmpty("every allowed field type has a rendering branch in the settings form", missing);
  check(
    "settings-form scan actually saw the type switch (non-vacuity)",
    (form.match(/case "/g) ?? []).length >= ALLOWED_FIELD_TYPES.length,
    `found ${(form.match(/case "/g) ?? []).length} case labels`
  );
}

// ---------------------------------------------------------------------------
section("The media read path resolves the site before it reads the object (rule 60)");
// ---------------------------------------------------------------------------

/**
 * `/media/<key>` used to be matched near the top of the router — above site
 * resolution and above authentication — and served straight out of R2. The
 * object key embeds its tenant (`uploads/{siteId}/…`), so that made a key
 * minted for one site readable on another site's host, and readable by an
 * anonymous visitor. `media_files` was already per-site; only this door was
 * site-blind, and because the admin list was already scoped the hole survived
 * every existing assertion.
 *
 * Two things are checked, and they fail independently:
 *
 *   1. **Order.** The branch has to sit after the `resolveSite` call, because
 *      only then is there a site to judge the key against. Moving it back up
 *      is a one-line edit that keeps every behaviour test green for as long as
 *      every site happens to be the default one.
 *   2. **It goes through the policy module.** A read path that reaches R2
 *      directly is the original defect wearing a different line number.
 */
{
  const index = blankComments(read(join(ROOT, "src", "index.ts")));
  // Anchored on `startsWith("/media/")`, not on the bare path literal: the
  // `media()` helper itself mentions `"/media/"` when slicing the prefix off,
  // and that mention sits *above* the router — so the looser anchor reported
  // the function definition as "the branch" and the guard was red on a correct
  // tree. It also has to match the shape a moved-back branch takes
  // (`u.pathname.startsWith(...)`), or moving it would go unnoticed.
  const mediaAt = index.indexOf('startsWith("/media/")');
  const resolveAt = index.indexOf("await resolveSite(");
  // Non-vacuity first: `-1 > -1` is false, so a renamed anchor would turn the
  // order assertion red for the wrong reason; state both anchors' presence.
  check(
    "the media branch and the site-resolution call are both present (non-vacuity)",
    mediaAt > -1 && resolveAt > -1,
    `"/media/" at ${mediaAt}, "await resolveSite(" at ${resolveAt}`
  );
  check(
    "the /media/ branch is matched after the site is resolved",
    mediaAt > resolveAt,
    `"/media/" at ${mediaAt} must come after "await resolveSite(" at ${resolveAt}`
  );
  checkEmpty(
    "the /media/ read path decides through platform/media-policy, not straight out of R2",
    index.includes("mediaReadDecision") ? [] : ["src/index.ts never calls mediaReadDecision"]
  );
}

// ---------------------------------------------------------------------------
section("A block's attributes are declared once and agreed on both sides (rule 61)");
// ---------------------------------------------------------------------------

/**
 * The editor used to write `attrs.text` for **every** block type while the
 * renderer read a different attribute per type (`url`+`alt` for an image,
 * `items` for a gallery, `html` for raw HTML, nested `content` for
 * group/columns). Nothing compared the two, so six of the twelve types produced
 * empty output at HTTP 200 when inserted from the admin — and every guard
 * stayed green, because the renderer is a one-line `switch` and the editor was
 * a single `<textarea>`.
 *
 * So the attribute list is declared in `rendering/blocks.ts`, shipped by
 * `GET /api/v1/blocks`, and **both sides are parsed and compared against it**:
 *
 *   1. the renderer must read exactly the attributes a block declares;
 *   2. every declared attribute type must have a control branch, and the list
 *      the control module exports must be the contract's closed set;
 *   3. a `media-list` attribute must declare its item keys (a control that has
 *      to be told them by its caller renders an empty field when nobody does).
 *
 * `tests/suites/editor-blocks.test.mjs` proves the same chain by *running* it;
 * these three are structural so `npm run gate` — which does not run that suite
 * — still catches a drift.
 */
{
  // 1. The renderer. `renderBlocks` is a dense one-liner, so the cases are
  //    parsed rather than grepped: a per-case scan is the only way to attribute
  //    an `a.<key>` read to the block that reads it.
  const frontend = blankComments(read(join(ROOT, "src", "platform", "frontend.ts")));
  const start = frontend.indexOf("export function renderBlocks");
  const end = frontend.indexOf("\n}", start);
  const body = start >= 0 && end > start ? frontend.slice(start, end) : "";
  const cases = [...body.matchAll(/case\s*"([^"]+)"\s*:\s*([\s\S]*?)(?=case\s*"|default\s*:)/g)];
  check(
    "the renderer's block switch was parsed (non-vacuity)",
    cases.length >= CORE_BLOCKS.length,
    `parsed ${cases.length} case bodies for ${CORE_BLOCKS.length} declared blocks`
  );

  const declaredAttrs = new Map(CORE_BLOCKS.map((b) => [b.name, b.attrs.map((a) => a.key).sort()]));
  const mismatches = [];
  for (const [, name, caseBody] of cases) {
    const readKeys = [...new Set([...caseBody.matchAll(/\ba\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
    const declared = declaredAttrs.get(name);
    if (!declared) { mismatches.push(`${name}: rendered but not declared`); continue; }
    if (JSON.stringify(readKeys) !== JSON.stringify(declared)) {
      mismatches.push(`${name}: reads [${readKeys}] but declares [${declared}]`);
    }
  }
  checkEmpty("the renderer reads exactly the attributes each block declares", mismatches);
  checkEmpty(
    "every declared block has a renderer case",
    [...declaredAttrs.keys()].filter((n) => !cases.some((m) => m[1] === n))
  );

  // 2. The editor's controls. The exported list is compared against the
  //    contract AND against the switch, so a type cannot be declared covered
  //    without a branch that actually renders it.
  const fieldsSrc = blankComments(read(join(ROOT, "public", "admin", "js", "block-fields.js")));
  const exported = (fieldsSrc.match(/export const RENDERED_ATTR_TYPES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "");
  const exportedTypes = [...exported.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(
    "the control module's type list matches the contract's closed set",
    // ⚠️ The comparison, not a JSON string of it. Passing the stringified
    // value as the condition is the same vacuous shape as passing an array:
    // `check` tests truthiness, and a non-empty string is always truthy. This
    // exact mistake shipped for one run and was caught by
    // `_skeleton-inject.mjs`'s "exported type list drifts" scenario, which is
    // the whole reason that tool exists.
    JSON.stringify([...exportedTypes].sort()) === JSON.stringify([...BLOCK_ATTR_TYPES].sort()),
    `implementation: ${JSON.stringify(exportedTypes)}\n       contract:       ${JSON.stringify(BLOCK_ATTR_TYPES)}`
  );
  const branches = [...fieldsSrc.matchAll(/case\s*"([a-z-]+)"\s*:/g)].map((m) => m[1]);
  checkEmpty(
    "every attribute type has a control branch",
    BLOCK_ATTR_TYPES.filter((t) => !branches.includes(t))
  );
  check(
    "the control switch was parsed (non-vacuity)",
    branches.length >= BLOCK_ATTR_TYPES.length,
    `found ${branches.length} case labels for ${BLOCK_ATTR_TYPES.length} types`
  );

  // 3. A media-list's item shape is part of the attribute.
  checkEmpty(
    "every media-list attribute declares its item keys",
    CORE_BLOCKS.flatMap((b) => b.attrs
      .filter((a) => a.type === "media-list" && !(Array.isArray(a.itemKeys) && a.itemKeys.length))
      .map((a) => `${b.name}.${a.key}`))
  );
  check(
    "the contract really declares a media-list (non-vacuity)",
    CORE_BLOCKS.some((b) => b.attrs.some((a) => a.type === "media-list"))
  );
}

// ---------------------------------------------------------------------------
section("The media control is defined once and the media URL is built once (rule 62)");
// ---------------------------------------------------------------------------

/**
 * "One control for choosing a file" is a claim about the *codebase*, not about
 * one screen. Three places need it — a block's `media` / `media-list`
 * attribute, a custom field of type `media` / `media-multiple`, and a
 * theme/plugin setting of the same type — and before this batch each built its
 * own answer. Two of them built no answer at all: the custom-field types are
 * declared in `ALLOWED_FIELD_TYPES` with **no control branch**, so they fell
 * through to a plain text input.
 *
 * Two lexical claims, both checkable without a browser:
 *
 *   1. the control's wrapper (`data-media-field`) and its button
 *      (`data-media-pick`) are emitted by exactly one module;
 *   2. `/media/<key>` is built in exactly one place. The read path checks the
 *      key's tenant before serving it (rule 60), so a URL assembled by hand is
 *      a 404 waiting for a filename with a slash in it — and the media screen
 *      had three of them.
 *
 * `data-media-pick-many` is a *different* attribute (the editor's "append
 * several" flow), so the pattern requires the name to end there.
 */
{
  const spaFiles = walk(join(ROOT, "public", "admin"), [".js"]);
  const sources = spaFiles.map((f) => ({ path: rel(f), src: blankComments(read(f)) }));

  const controlOwners = sources.filter((s) => /data-media-field/.test(s.src)).map((s) => s.path);
  checkEmpty("exactly one module emits the media control wrapper",
    controlOwners.filter((p) => p !== "public/admin/js/media-picker.js"));
  check("and it is the media picker", controlOwners.includes("public/admin/js/media-picker.js"),
    `owners: ${JSON.stringify(controlOwners)}`);
  const buttonOwners = sources.filter((s) => /data-media-pick(?![-\w])/.test(s.src)).map((s) => s.path);
  checkEmpty("exactly one module emits the picker button",
    buttonOwners.filter((p) => p !== "public/admin/js/media-picker.js"));
  check("and it is the media picker too", buttonOwners.includes("public/admin/js/media-picker.js"),
    `owners: ${JSON.stringify(buttonOwners)}`);
  // Non-vacuity: both patterns must really match the module we expect, or the
  // two checks above pass by finding nothing anywhere.
  const pickerSrc = sources.find((s) => s.path === "public/admin/js/media-picker.js")?.src ?? "";
  check("the picker module really defines both markers (non-vacuity)",
    /data-media-field/.test(pickerSrc) && /data-media-pick(?![-\w])/.test(pickerSrc));

  const urlBuilders = sources.filter((s) => /\/media\/\$\{encodeURIComponent/.test(s.src)).map((s) => s.path);
  checkEmpty("exactly one module builds a /media/ URL",
    urlBuilders.filter((p) => p !== "public/admin/js/media-picker.js"));
  check("and it is the module that exports mediaUrl", urlBuilders.includes("public/admin/js/media-picker.js"),
    `builders: ${JSON.stringify(urlBuilders)}`);
  check("and it really exports mediaUrl (non-vacuity)",
    /export function mediaUrl/.test(pickerSrc));
}

// ---------------------------------------------------------------------------
section("Every dictionary key the admin asks for exists in every core pack (rule 63)");
// ---------------------------------------------------------------------------

/**
 * `t(key, fallback)` falls back to the English source string, so **a missing key
 * is silent**: the screen renders correct-looking English while the rest of the
 * interface is in the user's language. That is the same "declared but never
 * consumed" family this repo keeps meeting, wearing the opposite hat — the code
 * asks for a key nobody declared, and the only symptom is one label that did not
 * translate.
 *
 * Batch 16 translated the content editor, which added ~90 keys across two
 * packs. Typing one of them differently in the code than in the dictionary is
 * exactly the mistake this section exists to catch, in both directions:
 *
 *   1. every key referenced from the SPA exists in **every** core pack
 *      (a key present in `en` but not `zh-CN` is just as broken);
 *   2. the two packs declare the **same** keys — a language that silently lacks
 *      a string is a language nobody can trust;
 *   3. the editor's own namespace is actually used. `core.editor.*` exists for
 *      one screen, so a key there with no call site is a string that was written
 *      and then forgotten.
 */
{
  const packSrc = read(join(ROOT, "src", "platform", "i18n", "core-pack.ts"));
  const packBody = (name) => {
    const m = packSrc.match(new RegExp(`const ${name}: Pack = \\{([\\s\\S]*?)\\n\\};`));
    return m ? [...m[1].matchAll(/"([^"]+)"\s*:/g)].map((x) => x[1]) : [];
  };
  const en = packBody("EN");
  const zh = packBody("ZH_CN");
  check("both core packs were parsed (non-vacuity)", en.length > 100 && zh.length > 100,
    `en=${en.length} keys, zh-CN=${zh.length} keys`);

  const enSet = new Set(en);
  const zhSet = new Set(zh);
  checkEmpty("no key is declared in one core pack but not the other",
    [...en.filter((k) => !zhSet.has(k)).map((k) => `${k} (missing from zh-CN)`),
     ...zh.filter((k) => !enSet.has(k)).map((k) => `${k} (missing from en)`)]);

  // Every `t("literal", …)` call site in the SPA. A dynamically built key
  // (`t(\`core.status.${s}\`)`) is invisible to this scan, which is why the
  // non-vacuity counter below matters: the scan has to be looking at a lot.
  const spaFiles = walk(join(ROOT, "public", "admin"), [".js"]);
  const referenced = new Map(); // key -> [files]
  for (const f of spaFiles) {
    const src = blankComments(read(f));
    for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      if (!referenced.has(m[1])) referenced.set(m[1], []);
      referenced.get(m[1]).push(rel(f));
    }
  }
  check("the SPA's t() call sites were found (non-vacuity)", referenced.size >= 40,
    `found ${referenced.size} distinct literal keys across ${spaFiles.length} files`);

  const unknown = [...referenced.entries()]
    .filter(([key]) => !enSet.has(key) || !zhSet.has(key))
    .map(([key, files]) => `${key} (${[...new Set(files)].join(", ")})`);
  checkEmpty("every key the admin asks for is declared in both core packs", unknown);

  // The reverse direction, scoped to the namespace that exists for one screen:
  // a `core.editor.*` entry with no call site is a string nobody shows.
  const editorKeys = en.filter((k) => k.startsWith("core.editor."));
  checkEmpty("every editor dictionary key has a call site",
    editorKeys.filter((k) => !referenced.has(k)));
  check("the editor namespace was parsed (non-vacuity)", editorKeys.length >= 30,
    `${editorKeys.length} core.editor.* keys`);
}

// ---------------------------------------------------------------------------
section("The autosave timer has one cleanup path (rule 64)");
// ---------------------------------------------------------------------------

/**
 * The editor starts a ten-second autosave interval for an existing item. It used
 * to clear it in **two** of its exit paths — `Back` and a successful save — so
 * leaving through the sidebar (which goes through `shell.go()`) left the
 * interval running: it kept POSTing an autosave while the user was on another
 * screen. Nothing failed. The writes were just invisible.
 *
 * The fix is that there is one definition, `stopAutosave()` in the shared leaf,
 * and `go()` / `switchSite()` call it. This check is the structural half of that
 * promise: **no module may clear the timer by hand**, because a hand-rolled
 * `clearInterval` is how the second cleanup path appears.
 *
 * The behavioural half lives in `admin-spa.test.mjs` ("editing an existing item
 * starts the autosave interval" / "and navigating away stops it") — a structure
 * check can only see that the call sites exist, not that navigation runs one.
 */
{
  const spaFiles = walk(join(ROOT, "public", "admin"), [".js"]);
  const handRolled = spaFiles
    .filter((f) => /clearInterval\s*\(\s*state\.autosaveTimer\s*\)/.test(blankComments(read(f))))
    .map((f) => rel(f));
  // (Written with `checkEmpty` on purpose: the first draft passed the array
  // itself as the condition, and `check()`'s boolean guard threw a TypeError —
  // which is the guard doing its job on the very check that documents it.)
  checkEmpty("only the shared helper clears the autosave timer",
    handRolled.filter((p) => p !== "public/admin/js/state.js"));
  check("and it really does (non-vacuity)",
    handRolled.includes("public/admin/js/state.js") && /export function stopAutosave/.test(read(join(ROOT, "public/admin/js/state.js"))));

  // Navigation is the path that was missing, so it is the one worth pinning.
  const shellSrc = blankComments(read(join(ROOT, "public/admin/js/shell.js")));
  check("navigation stops it", /stopAutosave\(\)/.test(shellSrc));
}

// ---------------------------------------------------------------------------
section("Bundled themes ship through Worker assets (rule 66)");
// ---------------------------------------------------------------------------

/**
 * Rule 65 exists because bundled themes used to have **no distribution
 * channel**: `seedBundledExtensions` wrote a registry row, but the actual
 * template/lang files only ever lived in R2 — and R2 starts empty. Every
 * database wipe therefore produced a homepage stuck in the `__fallback__`
 * shell at HTTP 200 until someone hand-uploaded the theme files object by
 * object; the "fix" was a manual `deploy-theme.mjs` run after every reset,
 * which is a patch, not a design.
 *
 * The design: bundled themes are read at runtime through the Worker's ASSETS
 * binding (`src/shared/bundled.ts`), served from `public/themes/**` — the
 * same directory wrangler uploads on every deploy. `content/themes/**` is the
 * editable source, `public/themes/**` is the synced copy (produced by
 * `scripts/sync-bundled-themes.mjs`, wired into `predeploy` and both
 * launchers), and this suite pins `public/themes/**` to **exactly the files of
 * the bundled themes**, byte-for-byte — so a template edited in `content/` but
 * never synced fails here instead of quietly serving stale markup in
 * production, and a directory that is not bundled (the test fixture) cannot
 * ride along into the deployed assets.
 *
 * Paired with the runtime fallback come the ownership guards: the bundled
 * names cannot be displaced by an upload or removed by an uninstall, because
 * "uninstall the default theme" would re-create the very fallback this rule
 * exists to prevent.
 *
 * Reverse validation: `tests/tools/_skeleton-inject.mjs` removes the assets
 * fallback, desynchronises a synced template, leaks a non-bundled theme into
 * `public/themes/`, and re-broadens the sync's copy set; the named assertions
 * below must go red on each defect.
 */
{
  // Parsed from source, not imported: `bundled.ts` sits above shared code that
  // uses extensionless relative imports, which Node's native TS stripping
  // cannot resolve — the same reason the schema section below parses
  // `PLATFORM_SCHEMA` out of `schema.ts` instead of importing it. The parse
  // itself lives in `scripts/sync-bundled-themes.mjs` (the script that *ships*
  // the set) and is imported here, so there is one place to keep correct. The
  // non-vacuity check immediately below is what keeps that shared parse honest.
  const bundledSrcRaw = read(join(ROOT, "src/shared/bundled.ts"));
  const BUNDLED_THEMES = readBundledThemeNames(BUNDLED_SRC);

  // -- the registry side -----------------------------------------------------
  check(
    "BUNDLED_THEMES was actually parsed (non-vacuity)",
    Array.isArray(BUNDLED_THEMES) && BUNDLED_THEMES.length >= 1,
    `got ${Array.isArray(BUNDLED_THEMES) ? BUNDLED_THEMES.length : typeof BUNDLED_THEMES} entries`
  );

  // Every bundled name must be a real, loadable theme package on disk. A
  // registry entry with no `theme.json` behind it seeds a theme that can be
  // activated but never rendered.
  const missingPackages = BUNDLED_THEMES.filter((n) => {
    const p = join(ROOT, "content", "themes", n, "theme.json");
    if (!existsSync(p)) return true;
    try { return JSON.parse(read(p)).name !== n; } catch { return true; }
  });
  checkEmpty("every bundled theme exists as a real package whose manifest name matches", missingPackages);

  // And the reverse direction: a directory under content/themes is either
  // bundled (seeded + guarded) or explicitly exempt. Without this, a theme
  // could exist on disk unseeded and unguarded — neither shipped nor
  // protected — which is exactly the half-state that made the original gap
  // invisible.
  const EXEMPT = new Set(["fixture"]); // test fixture: read by suites, not shipped as a product theme
  const themeDirs = readdirSync(join(ROOT, "content", "themes")).filter((d) =>
    statSync(join(ROOT, "content", "themes", d)).isDirectory()
  );
  check("the content/themes scan found the theme directories (non-vacuity)", themeDirs.length >= 2, themeDirs.join(", "));
  checkEmpty(
    "every content/themes directory is bundled or explicitly exempt",
    themeDirs.filter((d) => !BUNDLED_THEMES.includes(d) && !EXEMPT.has(d))
  );

  // -- the assets side: public/themes is exactly the bundled themes -----------
  //
  // ⚠️ This used to assert "the two trees agree file-for-file", and that was
  // the wrong invariant in the most expensive possible way: it made the *test
  // fixture* theme's presence under `public/themes/` a **requirement**. Every
  // file under `public/` is uploaded by `wrangler deploy`, so the suite was
  // pinning a test fixture onto the public internet — `/themes/fixture/theme.json`
  // answered 200 in production — while the comment a few lines above called
  // that theme "not shipped as a product theme". The two trees were never meant
  // to match: `content/themes/` may hold directories that must NOT ship. The
  // real invariant is "what ships is what `BUNDLED_THEMES` names", so that is
  // what is asserted, and the exemption is an *exclusion* rather than an
  // inclusion.
  const contentRoot = join(ROOT, "content", "themes");
  const publicRoot = join(ROOT, "public", "themes");
  const listFiles = (base) => {
    if (!existsSync(base)) return [];
    const out = [];
    const walkFiles = (dir) => {
      for (const e of readdirSync(dir)) {
        const abs = join(dir, e);
        if (statSync(abs).isDirectory()) walkFiles(abs);
        else out.push(relative(base, abs).split(sep).join("/"));
      }
    };
    walkFiles(base);
    return out.sort();
  };
  const bundledFiles = BUNDLED_THEMES
    .flatMap((n) => listFiles(join(contentRoot, n)).map((f) => `${n}/${f}`))
    .sort();
  const syncedFiles = listFiles(publicRoot);
  check("the bundled theme sources were actually scanned (non-vacuity)", bundledFiles.length >= 5, `${bundledFiles.length} files under the bundled theme(s)`);
  check("the synced assets tree was actually scanned (non-vacuity)", syncedFiles.length >= 5, `${syncedFiles.length} files under public/themes`);

  const missingFromAssets = bundledFiles.filter((f) => !syncedFiles.includes(f));
  const shippedButNotBundled = syncedFiles.filter((f) => !bundledFiles.includes(f));
  checkEmpty(
    "public/themes holds exactly the bundled themes' files (run scripts/sync-bundled-themes.mjs)",
    [
      ...missingFromAssets.map((f) => `missing from public/themes: ${f}`),
      ...shippedButNotBundled.map((f) => `shipped but not bundled: ${f}`),
    ]
  );

  // Named separately from the set comparison above so a leak names the rule it
  // breaks, and so the reverse-validation scenario has one assertion to pin.
  const notBundledDirs = themeDirs.filter((d) => !BUNDLED_THEMES.includes(d));
  checkEmpty(
    "no theme directory that is not bundled reaches the deployed assets",
    notBundledDirs.filter((d) => syncedFiles.some((f) => f.startsWith(`${d}/`)))
  );
  check(
    "the non-bundled scan is not vacuous (something on disk is there to be excluded)",
    notBundledDirs.length >= 1,
    `content/themes holds ${themeDirs.join(", ")}`
  );

  // Byte-for-byte, not just same names: a template edited in content/ but
  // never synced would otherwise keep shipping the old markup from public/.
  const drifted = bundledFiles
    .filter((f) => syncedFiles.includes(f))
    .filter((f) => read(join(contentRoot, f)) !== read(join(publicRoot, f)));
  checkEmpty("every synced theme file is byte-identical to its source", drifted);

  // And the sync has to *derive* its copy set from that one definition rather
  // than walking `content/themes/` — the shape that leaked the fixture in the
  // first place. Lexical, because it is the only way to see where the list
  // comes from: the tree above is clean today, and a future edit that
  // re-broadens the copy set would not show up in it until someone re-ran the
  // script by hand.
  const syncSrc = blankComments(read(join(ROOT, "scripts/sync-bundled-themes.mjs")));
  check("the sync reads the bundled names (not a hand-copied list)", /readBundledThemeNames|BUNDLED_THEMES/.test(syncSrc));
  checkEmpty(
    "the sync does not enumerate the whole content/themes directory",
    /listThemeFiles\(\s*sourceRoot\s*\)/.test(syncSrc)
      ? ["sync-bundled-themes.mjs walks content/themes directly — the fixture would ship again"]
      : []
  );

  // -- the runtime fallback is wired -----------------------------------------
  // The whole design rests on `bundledThemeFile` being reachable from **every**
  // place that loads theme content at runtime — which is why the check pins
  // each consumer site individually rather than testing "the identifier
  // appears somewhere in the file": the first draft did the latter, and
  // deleting the fallback in `loadThemeTemplate` alone left the identifier
  // matched by the probe and the langs reader, so the guard stayed green on a
  // build where templates render from nothing (caught by
  // `_skeleton-inject.mjs`, which is exactly what it is for).
  const runtimeSrc = blankComments(read(join(ROOT, "src/extensions/theme/runtime-declarative.ts")));
  const packsSrc = blankComments(read(join(ROOT, "src/extensions/theme/packs.ts")));
  const bundledSrc = blankComments(read(join(ROOT, "src/shared/bundled.ts")));
  check("the assets reader is defined in shared/bundled.ts", /export async function bundledThemeFile/.test(bundledSrc));
  check("the assets reader really goes through env.ASSETS (non-vacuity)", /env\.ASSETS\.fetch/.test(bundledSrc));

  const templateFallback = new RegExp(
    "await bundledThemeFile\\(env, theme\\.name, `templates/\\$\\{name\\}\\.html`\\)"
  ).test(runtimeSrc);
  const probeFallback = /await bundledThemeFile\(env, String\(c\.name\), "templates\/index\.html"\)/.test(runtimeSrc);
  const langsFallback = new RegExp(
    "await bundledThemeFile\\(env, theme\\.name, `langs/\\$\\{locale\\}\\.json`\\)"
  ).test(runtimeSrc);
  const packsFallback = /bundledThemeFile/.test(packsSrc);
  checkEmpty(
    "every theme-content consumer falls back to bundled assets (rule 66c)",
    [
      ...(templateFallback ? [] : ["runtime-declarative.ts loadThemeTemplate: no assets fallback on R2 miss"]),
      ...(probeFallback ? [] : ["runtime-declarative.ts activeTheme probe: no assets fallback"]),
      ...(langsFallback ? [] : ["runtime-declarative.ts loadThemeStrings: no assets fallback on R2 miss"]),
      ...(packsFallback ? [] : ["packs.ts: no assets fallback"]),
    ]
  );
  check(
    "the consumer scan actually saw the fallback sites (non-vacuity)",
    templateFallback && probeFallback && langsFallback && packsFallback,
    `template=${templateFallback} probe=${probeFallback} langs=${langsFallback} packs=${packsFallback}`
  );

  // -- the ownership guards ---------------------------------------------------
  // `ships with the product` is the refusal wording in src/api.ts for both the
  // upload and the uninstall guard. Two occurrences = both paths guarded;
  // one occurrence means someone deleted a guard, and a bundled name is
  // mutable again.
  const apiSrc = blankComments(read(join(ROOT, "src/api.ts")));
  check("both bundled-name guards exist in src/api.ts", (apiSrc.match(/ships with the product/g) || []).length >= 2,
    `found ${(apiSrc.match(/ships with the product/g) || []).length} occurrence(s)`);
  check("the guards read BUNDLED_THEMES (not a hand-copied list)", /BUNDLED_THEMES/.test(apiSrc));
}

// ---------------------------------------------------------------------------
section("A registry row is not an install (rule 69)");
// ---------------------------------------------------------------------------

/**
 * Rule 66 gave bundled themes a distribution channel, and
 * `seedBundledExtensions` writes the `theme_installs` row that makes one
 * renderable. It does not make the theme *own* anything. Activation is a user
 * action, and a fresh install has no user action in it.
 *
 * Measured on a fresh production install, before the fix: the bundled theme
 * served every page, `/zh-CN` and the language switcher included, while
 * `GET theme/fields` answered `{"items":[]}`. With no declared fields the
 * editor offered none, and `savePost`'s `fieldExists` gate dropped every
 * `meta` value on the way in — HTTP 200, no error, nothing written. The demo
 * content's `category`/`tags` came back `{}` and both home pages read
 * "Uncategorised". The visible symptom looked like a content problem; the
 * cause was that the theme had never been installed.
 *
 * Rule 4 forbids `plugin/` from importing `theme/`, so the seeder cannot
 * repair this itself. `index.ts` — the one module allowed to know both layers
 * — is where the two halves are chained, and this section pins that chain.
 * The behavioural half is the local probe recorded in HANDOVER: delete
 * `field_defs` for the site, restart the dev server so the isolate boots
 * fresh, and the fields come back with no activation call anywhere.
 *
 * Reverse validation: `tests/tools/_skeleton-inject.mjs` drops the second call
 * out of the boot chain, and separately replaces the row count with a version
 * stamp; the named assertions below must go red on each defect.
 */
{
  const bootSrc = blankComments(read(join(ROOT, "src/index.ts")));
  const capSrc = blankComments(read(join(ROOT, "src/extensions/theme/capabilities.ts")));

  const seeds = /await seedBundledExtensions\(env\)/.test(bootSrc);
  const installs = /await ensureThemeCapabilities\(env\)/.test(bootSrc);
  check(
    "the boot sequence installs what it registers",
    seeds && installs,
    `seed=${seeds} install=${installs}`
  );

  // Order is the assertion, not a detail: `ensureThemeCapabilities` resolves
  // the active theme out of `theme_installs`, which is the row the seeding
  // call is what creates. Reversed, it would read an empty registry on the
  // very boot it exists to repair.
  const seedAt = bootSrc.indexOf("await seedBundledExtensions(env)");
  const installAt = bootSrc.indexOf("await ensureThemeCapabilities(env)");
  check(
    "and it registers before it installs (rule 69a)",
    seedAt >= 0 && installAt > seedAt,
    `seed@${seedAt} install@${installAt}`
  );

  check(
    "the installer is a real function, not just a declaration (rule 69b)",
    /export async function ensureThemeCapabilities\(/.test(capSrc)
  );

  // The predicate has to be a *measurement*. A version stamp records "theme X
  // at version V was installed here", so it must be invalidated by anything
  // that deletes capability rows — and the suites delete exactly those rows on
  // purpose. A stamp would therefore refuse to repair the one state it exists
  // to repair, which is the defect it was introduced to fix.
  check(
    "the installed/not-installed predicate counts rows (rule 69c)",
    /SELECT COUNT\(\*\) FROM field_defs\s+WHERE site_id=\? AND declared_by_theme=\?/.test(capSrc)
  );

  // And it has to mirror the clear, or "installed" and "not installed" would
  // disagree about the same theme: `clearThemeCapabilities` deletes from five
  // tables plus the menu registry, so the count has to ask about all of them.
  const cleared = ["post_types", "taxonomies", "field_defs", "theme_routes", "theme_blocks"];
  const missingFromCount = cleared.filter(
    (t) => !new RegExp(`SELECT COUNT\\(\\*\\) FROM ${t}\\s`).test(capSrc)
  );
  checkEmpty("the predicate mirrors the clear (rule 69d)", missingFromCount);
}

// ---------------------------------------------------------------------------
section("The custom-field read ladder is defined once (rule 70)");
// ---------------------------------------------------------------------------

/**
 * `post_meta` carries a language since migration 0019, and "which value does
 * this language see" is a four-tier ladder (own locale → site default →
 * legacy `''` rows → anything). Like the content-locale fallback ladder
 * (rule 57's `resolveContentLocale`), the answer only stays consistent if it
 * is defined **once**: a listing, a single page and the admin's language rows
 * must resolve the same field the same way, and a second copy of the ladder
 * is how "the card says 设计 while the article says Design" comes back.
 *
 * Two structural claims, both checkable without a database:
 *
 *   1. the resolver is *defined* in exactly one module (`platform/post-meta.ts`);
 *   2. every module that reads `post_meta` resolves through it. A raw SELECT
 *      is allowed — the ladder needs the rows — but the *resolution* may not
 *      be re-implemented next to it.
 */
{
  const srcFiles = walk(join(ROOT, "src"), [".ts"]);
  const sources = srcFiles.map((f) => ({ path: rel(f), src: blankComments(read(f)) }));

  // ⚠️ `\b`, not `\(`: the declaration is generic —
  // `export function resolveMetaByPost<T extends MetaRow>(...)` — so a regex
  // that demands `(` right after the name matches nothing and both assertions
  // below pass by finding zero definers. The scenario that proves this guard
  // can fail anchors on the same spelling.
  const defRe = /function\s+resolveMetaByPost\b/;
  const definers = sources.filter((f) => defRe.test(f.src)).map((f) => f.path);
  check(
    "the meta read ladder is defined in exactly one module (rule 70)",
    definers.length === 1 && definers[0] === "src/platform/post-meta.ts",
    `defined in: ${definers.join(", ") || "nowhere"}`
  );

  const readers = sources.filter(
    (f) => f.path !== "src/platform/post-meta.ts" && /FROM\s+post_meta\b/.test(f.src)
  );
  const strays = readers.filter((f) => !f.src.includes("resolveMetaByPost"));
  checkEmpty("every post_meta reader resolves through the ladder (rule 70b)", strays.map((f) => f.path));

  // Non-vacuity: the reader scan must see the readers this rule was written
  // for. If the walk or the pattern silently empties, both assertions above
  // would pass by finding nothing — the exact shape the meta-guard exists for.
  check(
    "the ladder scan actually saw the post_meta readers (non-vacuity)",
    readers.length >= 3,
    `${readers.length} reader module(s): ${readers.map((f) => f.path).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
section("Switching a language version is a fetch, not a rename (rule 71)");
// ---------------------------------------------------------------------------

/**
 * A shared-row post (one `posts` id, one `post_translations` row per
 * language) hands the editor *every* language's content in one response. The
 * version bar used to answer a click by only relabelling
 * `state.editing.locale` — the previous language's title and blocks stayed on
 * screen under the new language's name. Nothing failed, HTTP was 200, and the
 * next save wrote the previous language's content into the other language's
 * row. A language switch that does not load the language's row is a data
 * destroyer wearing a navigation button.
 *
 * Two structural claims:
 *   1. the switch must re-fetch, naming the requested language;
 *   2. the relabel shape must not exist.
 *
 * And on the list side: the representative row is the *site's default
 * language* — never `MIN(locale)`, which answered "which translation sorts
 * first" and pinned bilingual lists to `en` by alphabetical coincidence
 * (rule 57's hardcoded-locale family, one spelling over).
 */
{
  const editorSrc = blankComments(read(join(ROOT, "public/admin/js/screens/editor.js")));

  check(
    "the version switch re-fetches the requested language's row (rule 71)",
    /await editContent\(state\.type, postId \|\| current\.id, locale\)/.test(editorSrc)
  );
  check(
    "and never just relabels the editing locale (rule 71b)",
    !/current\.locale = locale/.test(editorSrc)
  );

  const apiSrc = blankComments(read(join(ROOT, "src/api.ts")));
  check(
    "the content list pins the site's default language, never MIN(locale) (rule 71c)",
    /const pinned = locale \|\| dflt;/.test(apiSrc) && !/MIN\(locale\)/.test(apiSrc)
  );
}

// ---------------------------------------------------------------------------
section("A refusal must have an exit: forced theme uninstall (rule 72)");
// ---------------------------------------------------------------------------

/**
 * The themes screen told an operator whose theme was active elsewhere:
 * "Still active on: de. Deactivate it there first." — with no way to do that
 * from where they stood, and the occupying site possibly being one they had
 * just been handed by a test run. The 409 is the right *authority* (a theme
 * that renders a live site must not vanish silently), but a refusal with no
 * way out is how "this theme cannot be deleted" gets believed — the same
 * shape as the dead anchor and the unreachable dialog: the UI said something
 * true and useless.
 *
 * The exit is explicit: `?force=1` deactivates the theme on every occupying
 * site (they fall back to the bundled default, which rule 66 keeps renderable)
 * and then removes it. Two structural claims:
 *   1. the refusal is conditional on force being absent;
 *   2. the forced path repoints the occupying sites before removing anything.
 */
{
  const apiSrc = blankComments(read(join(ROOT, "src/api.ts")));

  check(
    "the uninstall refusal is conditional on force (rule 72)",
    /if\(sites\.length && !force\)/.test(apiSrc)
  );
  check(
    "the forced path deactivates occupants onto the bundled default (rule 72b)",
    /UPDATE settings SET value='default' WHERE site_id=\? AND key='theme\.active'/.test(apiSrc)
  );
}

// ---------------------------------------------------------------------------
section("A menu location resolves deterministically (rule 73)");
// ---------------------------------------------------------------------------

/**
 * `menu()` used to answer `SELECT id FROM menus WHERE location='header' AND
 * site_id=? LIMIT 1` — no ORDER BY. With two header menus (the admin could
 * freely create both), SQLite returned whichever row it felt like, so the
 * site's navigation could flip between requests with no code change. Rule
 * 73: a menu location resolves to one deterministic winner (`ORDER BY id`),
 * the set of locations comes from the active theme's manifest rather than a
 * literal in the query, and the SPA reads menus through `scoped()` so items
 * stay site-scoped end to end.
 */
{
  const feSrc = blankComments(read(join(ROOT, "src", "platform", "frontend.ts")));
  const rdSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));
  const themeJson = JSON.parse(read(join(ROOT, "content", "themes", "default", "theme.json")));
  const spaSrc = blankComments(read(join(ROOT, "public", "admin", "js", "screens", "menus.js")));

  check(
    "the menu-location lookup orders before limiting (rule 73)",
    /SELECT id FROM menus WHERE location=\? AND site_id=\? ORDER BY id LIMIT 1/.test(feSrc)
  );
  check(
    "the renderer reads locations from the theme manifest, not a literal (rule 73b)",
    /theme\.manifest\.menuLocations/.test(rdSrc)
      && !/location='header'/.test(feSrc)
  );
  check(
    "the bundled theme declares its menu locations",
    Array.isArray(themeJson.menuLocations) && themeJson.menuLocations.some((l) => l.id === "header")
  );
  check(
    "the menus screen reads menus through the site scope (rule 6)",
    /scoped\("menus"\)/.test(spaSrc)
  );
}

// ---------------------------------------------------------------------------
section("Widgets are site-scoped end to end (rule 74)");
// ---------------------------------------------------------------------------

/**
 * `widget_instances` was install-wide and the one read path that existed
 * (`GET /widgets`) had no tenant filter — on a multi-site install every
 * site's sidebar showed every site's widgets, the exact leak §10 rule 6
 * forbids (the menu twin: a shop's nav item on the default site's front
 * page). Rule 74: widgets are placement content, so every read carries
 * `site_id`, the scope the front end renders is the scope the admin edits,
 * and the contract declares the table what it really is.
 */
{
  const feSrc = blankComments(read(join(ROOT, "src", "platform", "frontend.ts")));
  const rdSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));
  const apiSrc = blankComments(read(join(ROOT, "src", "api.ts")));
  const schemaSrc = blankComments(read(join(ROOT, "src", "extensions", "contract", "schema.ts")));
  const themeJson = JSON.parse(read(join(ROOT, "content", "themes", "default", "theme.json")));

  check(
    "the widget render query carries the site id (rule 74)",
    /SELECT \* FROM widget_instances WHERE site_id=\? AND enabled=1/.test(feSrc)
  );
  check(
    "buildScope feeds the rendered widget groups into the template scope (rule 74b)",
    /widgetGroups\(env, siteId, o\.locale\)/.test(rdSrc)
  );
  check(
    "the admin widget listing is site-scoped too (rule 74c)",
    /SELECT \* FROM widget_instances WHERE site_id=\?/.test(apiSrc)
  );
  check(
    "the contract declares widget_instances a site table (rule 74d)",
    /table: "widget_instances", tenant: "site"/.test(schemaSrc)
  );
  check(
    "the bundled theme declares the sidebars it renders",
    Array.isArray(themeJson.sidebars) && themeJson.sidebars.some((s) => s.id === "footer")
  );
}

// ---------------------------------------------------------------------------
section("The admin prefix is injected and scoped (rule 75)");
// ---------------------------------------------------------------------------

/**
 * Batch C: the admin moves to a configurable prefix (`admin.path`). Three
 * structural facts make that work, and each is a one-line edit away from
 * silently regressing — the page still renders, so nobody notices until a
 * moved admin loads blank:
 *
 *   - the shell is *served through a rewriter* that injects the base
 *     (`serveAdminIndex`), not handed to the asset layer as a static file;
 *   - the admin API is mounted **under** the prefix and handed to the one API
 *     implementation after the prefix is stripped;
 *   - the old prefix, and the old login door, answer 404.
 *
 * The behavioural half lives in `admin-contract.test.mjs` (§0b/§0c) and the
 * SPA half in `admin-spa.test.mjs` (its own rule-75 section).
 */
{
  const indexSrc = blankComments(read(join(ROOT, "src", "index.ts")));
  const shellSrc = read(join(ROOT, "public", "admin", "index.html"));
  const authSrc = blankComments(read(join(ROOT, "src", "platform", "auth.ts")));

  check(
    "the shell is served through a base-injecting rewriter (rule 75a)",
    /function serveAdminIndex\(/.test(indexSrc) && /CFP_ADMIN_BASE/.test(indexSrc)
  );
  check(
    "the admin API is mounted under the prefix, not just the login door (rule 75b)",
    /p\.startsWith\(adminBase\+"\/api\/"\)\)return handleApi\(/.test(indexSrc)
  );
  // Rebuilding a request URL must carry its query string. The first version of
  // the prefix mount rebuilt from `u.origin` alone, so `?site=`, `?withCounts=1`,
  // `?locale=` and pagination all vanished on the prefixed route while `/api/*`
  // kept working — "some parameters work, others do not", across the whole admin.
  check(
    "the prefixed API mount carries the query string across (rule 75b)",
    /new URL\(p\.slice\(adminBase\.length\)\+u\.search,u\.origin\)/.test(indexSrc)
  );
  check(
    "the retired login endpoint answers 404 (rule 75c)",
    /if\(p==="\/api\/v1\/auth\/login"\)return new Response\("Not Found",\{status:404\}\)/.test(indexSrc)
  );
  check(
    "the old prefix's static assets are gated on the default prefix (rule 75c)",
    /adminBase==="\/admin"&&\(u\.pathname==="\/admin"/.test(indexSrc)
  );
  check(
    "the session cookie is named cfpress_admin (rule 75d)",
    /const SESSION_COOKIE = "cfpress_admin";/.test(authSrc)
  );
  check(
    "the session cookie path is the admin prefix, not a constant / (rule 75d)",
    /Path=\$\{cookiePath\}/.test(authSrc) && !/Set-Cookie[^\n]*Path=\/;/.test(authSrc)
  );
  check(
    "the shell still carries the /admin/ asset anchors the injection rewrites (rule 75a)",
    (shellSrc.match(/["']\/admin\//g) || []).length >= 3
  );
}

// ---------------------------------------------------------------------------
section("Site counts are grouped per site, and the theme is the site's choice (rule 76)");
// ---------------------------------------------------------------------------

/**
 * Batch 28 §3.1: the Sites screen became a management view. Two structural
 * facts carry it, and both have a wrong version that looks right in a
 * single-site install — which is the only configuration anyone tests by hand:
 *
 *   - the aggregate groups **by site**. The ungrouped `COUNT` answers the
 *     platform total, so every row still shows a plausible number and the
 *     defect needs a *second* site to become visible;
 *   - the theme column reads the site's own `theme.active` setting, not the
 *     renderer. `activeTheme()` probes storage and names a theme that merely
 *     happens to be installed, which would mark an unthemed site as themed.
 *
 * The seeds live here too: `createSite` has to give the new site its language
 * rows, because the "no rows → serve the whole dictionary" fallback makes a
 * missing seed invisible (the *served* list is identical either way).
 */
{
  const apiSrc = blankComments(read(join(ROOT, "src", "api.ts")));
  const sitesSrc = blankComments(read(join(ROOT, "src", "platform", "sites.ts")));
  const screenSrc = read(join(ROOT, "public", "admin", "js", "screens", "sites.js"));

  check(
    "the site counts are grouped by site, not collapsed into one total (rule 76a)",
    /GROUP BY site_id/.test(apiSrc) && /withCounts/.test(apiSrc)
  );
  // The guard has to fail on the *ungrouped* shape specifically, so assert the
  // absence of a posts count that has no grouping — matching the defect rather
  // than the fix. Without this, deleting the `GROUP BY` from one of the three
  // counts is caught only by the behavioural suite.
  check(
    "no site count is computed without a per-site grouping (rule 76a)",
    !/COUNT\(\*\) AS count FROM posts WHERE type='(post|page)'(?![\s\S]{0,80}GROUP BY site_id)/.test(apiSrc)
  );
  check(
    "the theme column reads the site's own theme.active setting, not the renderer (rule 76b)",
    /settings WHERE key='theme\.active'/.test(apiSrc)
  );
  check(
    "a newly created site is given its language rows (rule 76c)",
    /seedSiteLocales\(env, safeId\)/.test(sitesSrc)
  );
  // The screen's preview URL is built per site. Asserting the helper exists and
  // reads the site's own fields stops a rewrite to the *current* site's prefix
  // — which opens a different site and calls it a preview.
  check(
    "the Sites screen builds each preview URL from that site's own prefix or host (rule 76)",
    /function siteFrontEnd\(s\)/.test(screenSrc) && /s\?\.path_prefix/.test(screenSrc) && /s\?\.host/.test(screenSrc)
  );
  check(
    "the Sites screen asks for the counts in one request, not one per row (rule 76a)",
    /api\("sites\?withCounts=1"\)/.test(screenSrc)
  );
}

// ---------------------------------------------------------------------------
section("The two identities are structurally apart, not policy-apart (rule 77)");
// ---------------------------------------------------------------------------

/**
 * Batch D. The front end has its own identity — `members`, `member_sessions`,
 * the `cfpress_member` cookie, the `/api/v1/front/…` family — and the whole
 * design rests on that identity being **structurally** separate from the
 * admin's rather than gated by a check somebody has to remember to write.
 *
 * "There is nothing to exchange" is the claim, and it is a claim about code:
 *
 *   - the two session tables are different tables, so a member session id is
 *     not a valid admin session id (and vice versa) — there is no shared id
 *     space to confuse;
 *   - `currentMember` reads `member_sessions`; `currentUser` reads
 *     `admin_sessions`. Neither queries the other's table, so neither can
 *     "accidentally" accept the other's token;
 *   - the two cookies have different **names**, which is the only way a single
 *     `Cookie:` header carrying both can be told apart. A generic name (or a
 *     shared one) is how the next reader conflates them;
 *   - the member tables carry `site_id` and every read puts it in the WHERE
 *     clause, because "member" is a tenant fact — A site's account must not
 *     exist on B site, and a missing `site_id` makes it exist everywhere.
 *
 * Each guard below is written against the *defect* shape, not the fix: the
 * point is to go red when someone reintroduces the sharing, not merely to
 * confirm that today's line is present.
 */
{
  const membersSrc = blankComments(read(join(ROOT, "src", "platform", "members.ts")));
  const authSrc = blankComments(read(join(ROOT, "src", "platform", "auth.ts")));
  const apiSrc = blankComments(read(join(ROOT, "src", "api.ts")));
  const migSrc = read(join(ROOT, "content", "migrations", "0022_front_members.sql"));

  // (a) The cookie names differ. Reading the two constants and comparing them
  // beats re-typing the literals here: a rename on one side is caught, and the
  // guard cannot silently agree with a typo in its own expected value.
  const adminCookie = authSrc.match(/const SESSION_COOKIE = "([^"]+)"/)?.[1] ?? "";
  const memberCookie = membersSrc.match(/const MEMBER_COOKIE = "([^"]+)"/)?.[1] ?? "";
  check("the admin cookie name is read from its definition (rule 77a)", adminCookie === "cfpress_admin", `got "${adminCookie}"`);
  check("the member cookie name is read from its definition (rule 77a)", memberCookie === "cfpress_member", `got "${memberCookie}"`);
  check("the two cookie names are different (rule 77a)", adminCookie !== "" && adminCookie !== memberCookie);

  // (b) Each resolver reads only its own session table. This is the load-bearing
  // assertion: a `currentMember` that read `admin_sessions` would accept an
  // admin cookie on the front end, and the red-line test would still pass as
  // long as nobody presented one.
  check(
    "currentMember resolves against member_sessions, never admin_sessions (rule 77b)",
    /FROM member_sessions/.test(membersSrc) && !/FROM admin_sessions/.test(membersSrc)
  );
  check(
    "currentUser resolves against admin_sessions, never member_sessions (rule 77b)",
    /FROM admin_sessions/.test(authSrc) && !/member_sessions/.test(authSrc)
  );
  // The front-end API must go through `requireMember`/`currentMember`, never
  // `requirePermission`/`currentUser` — those are the admin doors, and routing
  // a member request through them is the conflation the whole design forbids.
  check(
    "the front-end API authorises with the member resolver, not the admin one (rule 77b)",
    /requireMember\(/.test(apiSrc) && /handleFrontApi/.test(apiSrc)
  );
  // Extract the front-end router body and assert the admin authorisers are
  // absent from it. Reading the *body* rather than the whole file matters:
  // `api.ts` contains both routers, so a whole-file test would fail on the
  // admin router's own (correct) `requirePermission` calls.
  //
  // `routeFrontApi` is defined *below* `handleFrontApi` (the export wraps the
  // private router), and the next top-level declaration after it is the admin
  // router `routeApi`. Bound the slice there — falling through into the admin
  // router would fail this check on the admin's own correct `currentUser`.
  const frontStart = apiSrc.indexOf("async function routeFrontApi");
  let frontEnd = -1;
  if (frontStart >= 0) frontEnd = apiSrc.indexOf("\nasync function ", frontStart + 1);
  const frontBody = frontStart < 0 || frontEnd < 0 ? "" : apiSrc.slice(frontStart, frontEnd);
  check(
    "the front-end route body was actually extracted (non-vacuity)",
    frontBody.length > 100
  );
  check(
    "the front-end route never calls the admin permission check (rule 77b)",
    !/requirePermission\(/.test(frontBody) && !/currentUser\(/.test(frontBody)
  );

  // (c) The member tables are site-scoped in the schema itself. A table that
  // declared neither a `site_id` column nor a derived tenant would let
  // `deleteSite` skip it silently — the purge loop is `WHERE site_id=?`.
  check(
    "members is created with its own site_id (rule 77c)",
    /CREATE TABLE[^;]*\bmembers\b[\s\S]*?site_id\s+TEXT NOT NULL/i.test(migSrc)
  );
  check(
    "member_sessions carries site_id too (rule 77c)",
    /CREATE TABLE[^;]*member_sessions[\s\S]*?site_id\s+TEXT NOT NULL/i.test(migSrc)
  );
  // The username is unique *within a site*, not globally: two sites may each
  // have a `bob`, and the uniqueness that stops a duplicate is scoped to the
  // tenant. A global UNIQUE would make one site's registration block another's.
  check(
    "the member username is unique per site, not globally (rule 77c)",
    /UNIQUE INDEX[^;]*idx_members_site_username[^;]*\(site_id,\s*username\)/i.test(migSrc)
  );
  // And every read in the member platform filters on it. `WHERE site_id=?` two
  // or more times is the shape of the join (`s.site_id=? AND m.site_id=?`);
  // a single filter is not enough because the join could be satisfied by the
  // session row while the member row belongs to another site.
  check(
    "the member lookup always constrains both halves by site (rule 77c)",
    (membersSrc.match(/site_id\s*=\s*\?/g) ?? []).length >= 3
  );

  // (d) The member tables are declared in the schema contract as site tables,
  // so they can never be forgotten by the per-site purge.
  const contractSrc = read(join(ROOT, "src", "extensions", "contract", "schema.ts"));
  check(
    "the contract declares members a site table (rule 77d)",
    /\{\s*table:\s*"members",\s*tenant:\s*"site"/.test(contractSrc)
  );
  check(
    "the contract declares member_sessions a site table (rule 77d)",
    /\{\s*table:\s*"member_sessions",\s*tenant:\s*"site"/.test(contractSrc)
  );
  // Non-vacuity: the files really were read. A regex over an empty string
  // passes every `!test` guard above, which is the classic way a guard goes
  // green on a typo'd path.
  check(
    "the rule-77 sources were actually read (non-vacuity)",
    membersSrc.length > 500 && migSrc.length > 300 && authSrc.length > 500
  );

  // (e) The theme scope carries the member, and it does so through
  // `currentMember` — a theme must never be handed the admin resolver. The
  // field is on the platform side, so a theme cannot forge or clear it.
  const declSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));
  check(
    "the theme scope resolves the member through currentMember (rule 77e)",
    /currentMember\(env,\s*o\.request,\s*siteId\)/.test(declSrc)
  );
  check(
    "the theme scope exposes member as its own key (rule 77e)",
    /^\s*member,$/m.test(declSrc)
  );
}

// ---------------------------------------------------------------------------
section("A permission answer names the site it is about (rule 78)");
// ---------------------------------------------------------------------------

/**
 * Batch E. Batch D split the *identities*; this batch splits the *authority*.
 * The old `can(env, user, permission)` read one column — `site_users.role` —
 * so an `editor` on the shop site was an `editor` everywhere. There was no
 * site in the question, and therefore no way for "may this person publish
 * *here*" to be false for one site and true for another.
 *
 * The fix is `site_users_sites(user_id, site_id, role)`: one row per
 * (person, site), and the absence of a row is the denial. Three things make it
 * stick, and each is a guard below:
 *
 *   (a) `siteId` is a **required** parameter, not optional-with-a-default. An
 *       optional parameter lets a call site ask the site-blind question again —
 *       and that question still *has* an answer (it reads someone's row), so
 *       the defect survives review. Required means the compiler names every
 *       place that has to decide which site it means.
 *   (b) Every `requirePermission` call site passes a `siteId`. A missed call
 *       site is a call that silently answered for the wrong tenant, and the
 *       only way to see it is to look at all of them at once.
 *   (c) No fallback to `site_users.role`. A fallback is how "removed from a
 *       site" becomes "still has access to it": the membership row is gone,
 *       the fallback answers anyway, and the removal appears to have worked
 *       while nothing changed.
 *
 * Each guard is written against the *defect* shape, not the fix.
 */
{
  const permSrc = blankComments(read(join(ROOT, "src", "platform", "permissions.ts")));
  const apiSrc = blankComments(read(join(ROOT, "src", "api.ts")));
  const authSrc = blankComments(read(join(ROOT, "src", "platform", "auth.ts")));
  const contractSrc = blankComments(read(join(ROOT, "src", "extensions", "contract", "schema.ts")));
  const roleMigSrc = read(join(ROOT, "content", "migrations", "0023_site_user_roles.sql"));

  // (a) `can` and `requirePermission` take a required `siteId`. The signature is
  // read from the source rather than trusted: a fourth parameter that is
  // optional (`siteId?: string` or `siteId: string = "…"`) is the exact
  // regression this rule exists to catch, and it is a one-character edit.
  //
  // The default-value test has to reach past the type: `siteId: string = "x"`
  // puts the `=` after `string`, so `siteId\s*=` alone would miss it. Anything
  // between the name and the `,`/`)` that closes the parameter is refused.
  const canParams = permSrc.match(/export async function can\(([\s\S]*?)\)\s*:\s*Promise<boolean>/)?.[1] ?? "";
  const reqParams = permSrc.match(/export async function requirePermission\(([\s\S]*?)\)\s*:\s*Promise<boolean>/)?.[1] ?? "";
  const siteIdIsRequired = (params) =>
    /siteId\s*:\s*string\b/.test(params) &&
    !/siteId\s*\?/.test(params) &&
    !/siteId\s*:[^,)]*=/.test(params);
  check(
    "can() takes a required siteId (rule 78a)",
    siteIdIsRequired(canParams),
    canParams.replace(/\s+/g, " ").trim().slice(0, 90)
  );
  check(
    "requirePermission() takes a required siteId (rule 78a)",
    siteIdIsRequired(reqParams),
    reqParams.replace(/\s+/g, " ").trim().slice(0, 90)
  );

  // (b) Every `requirePermission(` call site passes four arguments. Counting is
  // the point: a single missed call site is invisible to a `!test`, because the
  // other thirty-nine still match. Every call in this file is spelled
  // `requirePermission(env, user, "<perm>", siteId)` — the regex requires the
  // literal permission and the trailing `siteId`, so a three-argument call has
  // nowhere to hide. The count must equal the total number of call sites.
  const allCalls = [...apiSrc.matchAll(/requirePermission\(/g)].length;
  const okCalls = [
    ...apiSrc.matchAll(/requirePermission\(\s*env\s*,\s*user\s*,\s*"[^"]+"\s*,\s*siteId\s*\)/g),
  ].length;
  check(
    "every requirePermission call site passes a siteId (rule 78b)",
    allCalls > 0 && okCalls === allCalls,
    `${okCalls}/${allCalls} call sites carry siteId`
  );
  // The permission passed must be a site-scoped one unless it is in the
  // platform set. This is what stops a new caller from asking an install-wide
  // question with a site in hand and getting the wrong answer: the platform
  // permissions are a closed, named set, and anything else is per-site.
  const platformPerms = new Set(
    [...permSrc.matchAll(/PLATFORM_PERMISSIONS[^=]*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/g)]
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
  );
  check(
    "the platform-permission set is declared and non-empty (rule 78b)",
    platformPerms.size >= 3,
    [...platformPerms].join(", ")
  );
  const usedPerms = new Set(
    [...apiSrc.matchAll(/requirePermission\(\s*env\s*,\s*user\s*,\s*"([^"]+)"/g)].map((m) => m[1])
  );
  // Non-vacuity: the previous regex must have found the calls at all.
  check(
    "the rule-78 permission scan actually matched call sites (non-vacuity)",
    usedPerms.size >= 4,
    [...usedPerms].join(", ")
  );

  // (c) No fallback. `can()` must read `site_users_sites` — a query against
  // `site_users.role` inside `can()` is the site-blind answer coming back. The
  // membership table is the *only* place `can()` may get a role from; the
  // identity table's `role` column is read by `superadmin`'s own check (that is
  // `user.role`, an in-memory field, not a second query).
  check(
    "can() reads the membership table, never site_users.role (rule 78c)",
    /FROM site_users_sites/.test(permSrc) && !/FROM site_users\b(?!_)/.test(permSrc)
  );
  // Reading the membership table is not enough — the lookup must **constrain by
  // site**. A query that keeps the table but drops `site_id = ?` is well-formed,
  // returns a row, and hands back whichever membership it finds first: the same
  // site-blind answer, wearing the membership table's clothes. This is the one
  // regression the `FROM` check above cannot see, so the WHERE clause is pinned
  // separately.
  check(
    "the membership lookup filters on the site, not just the user (rule 78c)",
    /FROM site_users_sites WHERE user_id = \? AND site_id = \?/.test(permSrc)
  );
  check(
    "the absence of a membership row is a denial (rule 78c)",
    /if\s*\(!row\)\s*return false/.test(permSrc)
  );
  // `superadmin` short-circuits first — it is the answer for a site that does
  // not exist yet — and it is an install-wide role on `site_users`, not a
  // per-site value.
  check(
    "superadmin short-circuits before the membership lookup (rule 78c)",
    /user\.role\s*===\s*SUPERADMIN_ROLE[\s\S]{0,40}return true/.test(permSrc)
  );

  // (a′) The admin gate derives its role set from the same declaration. A
  // hardcoded list here is how `superadmin` — added by migration 0023 — got
  // locked out of every admin endpoint while the tests still passed.
  check(
    "the admin gate derives its roles, not a hardcoded list (rule 78a)",
    /ADMIN_ROLES/.test(authSrc) && !/\["admin",\s*"editor",\s*"author"\]/.test(authSrc)
  );
  check(
    "the derived admin set includes superadmin (rule 78a)",
    /SITE_ROLES[\s\S]{0,80}SUPERADMIN_ROLE/.test(authSrc)
  );

  // (d) The membership table is declared a site table, and the per-site role
  // edit cannot hand out `superadmin`. `SITE_ROLES` is the closed set a site
  // screen may assign; the install-wide role is granted by migration or by the
  // owner editing the identity directly.
  check(
    "the contract declares site_users_sites a site table (rule 78d)",
    /\{\s*table:\s*"site_users_sites",\s*tenant:\s*"site"/.test(contractSrc)
  );
  check(
    "superadmin is not an assignable per-site role (rule 78d)",
    /SITE_ROLES\s*=\s*\[[^\]]*\]/.test(permSrc) && !/SITE_ROLES\s*=\s*\[[^\]]*superadmin/.test(permSrc)
  );
  const migBody = roleMigSrc.replace(/--[^\n]*/g, "");
  check(
    "the migration carries site_id and backfills before it is read (rule 78d)",
    /CREATE TABLE[^;]*site_users_sites[\s\S]*?site_id\s+TEXT NOT NULL/i.test(migBody) &&
      /INSERT OR IGNORE INTO site_users_sites/i.test(migBody)
  );

  // The files really were read. A regex over an empty string passes every
  // `!test` above, which is the classic way a guard goes green on a typo'd path.
  check(
    "the rule-78 sources were actually read (non-vacuity)",
    permSrc.length > 500 && apiSrc.length > 5000 && authSrc.length > 200 && roleMigSrc.length > 200
  );
}

// ---------------------------------------------------------------------------
section("The admin UI answers the same question the API does (rule 79)");
// ---------------------------------------------------------------------------

/**
 * Batch E2. Rule 78 fixed the *server* half of per-site authority; this is the
 * client half, and it fails differently.
 *
 * A backend that stops reading `site_users.role` is invisible from a screen
 * that still prints it. After E1 the users table kept rendering `x.role` — the
 * install-wide identity — under a column headed "Role", so an account whose
 * install-wide role is `author` and who is the **admin of the site being
 * viewed** read as "author". Nothing threw, nothing 403'd: the screen answered
 * a question the API had stopped asking, using a field that still has a value.
 * That is the "declared but never consumed" family wearing a UI hat, and the
 * only way to catch it is to pin which field the screen reads.
 *
 * Two statements, both about *which fact is read* rather than how it is drawn:
 *
 *   (a) the users screen reads the per-site facts (`role_here`, `sites`) and
 *       does not render the install-wide `role` as a site's role;
 *   (b) the switcher's site list comes from `state.sites` — which is `GET
 *       sites`, filtered server-side by membership (rule 78) — and is not a
 *       hard-coded list that would offer a site the API refused.
 */
{
  const usersSrc = blankComments(read(join(ROOT, "public", "admin", "js", "screens", "users.js")));
  const navSrc = blankComments(read(join(ROOT, "public", "admin", "js", "nav.js")));

  // (a) The screen must *consume* what the endpoint added for it. Reading
  // neither field means the endpoint's `role_here` / `sites` are provided and
  // ignored — a payload nothing reads, which is how the stale column survived.
  check(
    "the users screen reads the per-site role the API provides (rule 79a)",
    /role_here/.test(usersSrc)
  );
  // The membership map must be *rendered*, not merely mentioned: the screen
  // legitimately reads `userRow.sites` to seed the editor dialog, so a loose
  // "`.sites` appears" test stays green even after the column that shows other
  // sites is deleted. The anchor is the call that renders it.
  check(
    "the users screen reads the membership map, so other sites are visible (rule 79a)",
    /otherSitesText\(\s*x\.sites\s*,/.test(usersSrc)
  );
  // The defect shape, pinned: the column bound to the install-wide `role` field
  // is what printed the wrong answer. A bare `x.role` may still appear (the
  // screen legitimately compares it to `superadmin`), so the guard targets the
  // *render* of it as a badge — `roleBadge(x.role)` / `esc(x.role)` in the row.
  check(
    "and never renders the install-wide role as a site's role (rule 79a)",
    !/roleBadge\(\s*x\.role\s*\)/.test(usersSrc) && !/badge[^>]*>\$\{esc\(x\.role\)\}/.test(usersSrc)
  );
  // `superadmin` is install-wide: it is compared, never offered as a choice.
  //
  // Two mechanisms could leak it, so both are pinned. The visible one is an
  // explicit option — but the *live* one is the role set the options are built
  // from, and a guard that only looks for `value: "superadmin"` never fires,
  // because no such literal exists: the options are `SITE_ROLE_VALUES.map(...)`.
  // (That is exactly how the first draft of this guard went green on the
  // injection — reverse validation caught it.) So: the set is closed and does
  // not contain it, *and* the options are derived from the set.
  check(
    "superadmin is not offered as a per-site role in the UI (rule 79d)",
    /SITE_ROLE_VALUES\s*=\s*\[[^\]]*\]/.test(usersSrc) &&
      !/SITE_ROLE_VALUES\s*=\s*\[[^\]]*superadmin/.test(usersSrc) &&
      !/value:\s*"superadmin"/.test(usersSrc),
    usersSrc.match(/SITE_ROLE_VALUES\s*=\s*\[[^\]]*\]/)?.[0] ?? "no SITE_ROLE_VALUES set found"
  );
  check(
    "the role options are derived from that one set, not re-listed (rule 79d)",
    /SITE_ROLE_VALUES\.map\(\s*\(r\)\s*=>\s*\(\{\s*value:\s*r/.test(usersSrc)
  );

  // (b) The switcher is built from the API's (filtered) site list. A literal
  // array here is the way a scoped user gets offered a site they cannot open.
  //
  // The anchor is the *binding*, not a loose "these two appear nearby": `state`
  // also holds other `state.sites` reads (the header's own lookup) within any
  // window wide enough to be useful, so a distance-based match stays green on
  // a hard-coded list. `siteOptions` is the one list the dropdown renders, and
  // it must be the sorted-free map over `state.sites` itself.
  check(
    "the site switcher offers state.sites, not a hard-coded list (rule 79b)",
    /const siteOptions = state\.sites\s*\n?\s*\.map\(/.test(navSrc),
    navSrc.match(/const siteOptions = [\s\S]{0,80}/)?.[0]?.replace(/\n/g, " ") ?? "no siteOptions binding found"
  );
  check(
    "the switcher's rows always carry the site id the API returned (rule 79b)",
    /data-switch-site="\$\{attr\(s\.id\)\}"/.test(navSrc)
  );

  check(
    "the rule-79 sources were actually read (non-vacuity)",
    usersSrc.length > 800 && navSrc.length > 2000
  );
}

// ---------------------------------------------------------------------------
section("A staff identity is deleted together with its memberships (rule 80)");
// ---------------------------------------------------------------------------

/**
 * Batch F. Batch E split a staff user in two: the identity (`site_users`) and
 * the per-site memberships (`site_users_sites`). Splitting one row out of
 * another is how a second row is born that has to die with the first — and
 * SQLite does not cascade here (no FK declared on the table, and D1 enables
 * foreign keys per connection), so nothing removes the memberships for us.
 *
 * There is no product endpoint that deletes a user, so today the only orphan
 * memberships are in test teardowns. That is precisely why the cleanup belongs
 * in **one function next to the identity** rather than in a future endpoint:
 * the failure mode is not "a row stays behind" (invisible while nothing points
 * at it) but "a *later* user reusing an id inherits a stranger's access".
 *
 * The guard does not require that a caller exists — it requires that the
 * two-statement delete has exactly one definition, so that whoever adds the
 * endpoint finds it instead of re-deriving half of it.
 */
{
  const authSrc = blankComments(read(join(ROOT, "src", "platform", "auth.ts")));

  check(
    "the membership-and-identity delete is defined once, next to the identity (rule 80)",
    /export async function deleteUser\s*\(\s*env\s*:\s*Env\s*,\s*userId\s*:\s*string\s*\)/.test(authSrc)
  );
  // Both rows, in one batch: the memberships first, then the identity. A
  // `deleteUser` that removes only `site_users` reintroduces the orphan this
  // rule exists to prevent, and reads identically at the call site.
  check(
    "it removes the memberships as well as the identity (rule 80)",
    /DELETE FROM site_users_sites WHERE user_id=\?/.test(authSrc) &&
      /DELETE FROM site_users WHERE id=\?/.test(authSrc)
  );
  // The two statements are not run independently: an identity gone while its
  // membership rows still exist is a state no reader expects, and the way to
  // make that unobservable is a single `batch`.
  check(
    "both statements run in one batch, so the intermediate state is unobservable (rule 80)",
    /env\.DB\.batch\(\[\s*[\s\S]{0,400}?DELETE FROM site_users_sites[\s\S]{0,400}?DELETE FROM site_users\b/.test(authSrc)
  );
  // The defect shape, pinned lexically across the whole platform: a direct
  // `DELETE FROM site_users` outside `deleteUser` is a delete that forgot the
  // memberships. Scoped to `src/` — tests legitimately delete users inline in
  // teardowns, and the point here is the product's own code.
  const productSrc = blankComments(
    walk(join(ROOT, "src"), [".ts"])
      .map((f) => read(f))
      .join("\n")
  );
  const directDeletes = [
    ...productSrc.matchAll(/DELETE FROM site_users\b(?!_)/g),
  ].length;
  check(
    "no other place in src/ deletes an identity on its own (rule 80)",
    directDeletes === 1,
    `${directDeletes} direct \`DELETE FROM site_users\` in src/ (expected exactly the one in deleteUser)`
  );

  check(
    "the rule-80 source was actually read (non-vacuity)",
    authSrc.length > 3000 && productSrc.length > 10000
  );
}

// ---------------------------------------------------------------------------
section("Templates see a projection, not a row (rule 81)");
// ---------------------------------------------------------------------------

/**
 * Theme batch. Every object in the template scope is a **projection of a
 * database row**, and its fields are snake_case (`post.reading_time`,
 * `page.document_title`, `site.title`) — because they come from rows.
 * `publicMember` returns camelCase (`displayName`), which is right for the JSON
 * API and wrong for a template: `{{member.display_name}}` resolves to
 * `undefined` and renders **empty**, with HTTP 200 and no error anywhere.
 *
 * That is what shipped. Every theme's sign-in branch wrote
 * `{{member.display_name}}` — following the column it comes from — and printed
 * a blank name. `theme-default.test.mjs` §8b stayed green because its fixture
 * hand-wrote `display_name`, a shape the real scope never produced: a fixture
 * that invents a shape the runtime does not produce is a guard that cannot fail
 * (§12 #5).
 *
 * This section is deliberately **lexical**, and the reason is worth stating: no
 * suite in this repository drives the real `buildScope` — they all render
 * templates against a hand-built scope object. So a behavioural guard here
 * would have to stand up D1, R2, KV and a request just to read one field, while
 * the property that actually matters ("the scope is built by calling the
 * projection, not by passing the row through") is a property of one line. The
 * behavioural half lives in `theme-default.test.mjs` §8b, which derives its
 * fixture from `memberScope()` itself so the two cannot drift.
 */
{
  const membersSrc = blankComments(read(join(ROOT, "src", "platform", "members.ts")));
  const rdSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));

  // The projection exists and carries the snake_case key the templates ask for.
  check(
    "the member projection is defined (rule 81a)",
    /export function memberScope\s*\(\s*member\s*:\s*MemberUser\s*\)/.test(membersSrc)
  );
  check(
    "the projection carries display_name, not displayName (rule 81a)",
    /\bdisplay_name\s*:/.test(membersSrc) && !/\bdisplayName\s*:\s*display\b/.test(membersSrc)
  );
  // The projected object is what templates receive, so a password hash on it
  // would be handed to user-authored markup with nothing to notice. Slice the
  // *function body* — a whole-file scan matches the hashes in the login query
  // and the `publicMember` comment, which are supposed to be there. The first
  // draft of this assertion sliced from the function to end-of-file and went
  // red on correct code: a guard that fails correct code gets weakened.
  const scopeFnStart = membersSrc.indexOf("export function memberScope");
  const scopeFnEnd = membersSrc.indexOf("function publicMember", scopeFnStart);
  const scopeFn = scopeFnStart >= 0 ? membersSrc.slice(scopeFnStart, scopeFnEnd > 0 ? scopeFnEnd : scopeFnStart + 800) : "";
  check(
    "the projection may carry no password hash (rule 81b)",
    scopeFn.length > 100 && !/password_hash|passwordHash/.test(scopeFn)
  );

  // The scope is built *through* the projection. This is the line the defect
  // was: passing `memberRow` straight through hands templates a row-shaped
  // object, and every `{{member.<field>}}` read misses silently.
  check(
    "buildScope projects the member row before handing it to templates (rule 81a)",
    /const member\s*=\s*memberRow\s*\?\s*memberScope\s*\(\s*memberRow\s*\)\s*:/.test(rdSrc)
  );
  // The negative direction, written as a *positive* statement about the only
  // shape allowed rather than a lookahead. The earlier attempt used
  // `/const member\s*=\s*memberRow\s*(?!\?)/`, whose trailing `\s*` made the
  // zero-width lookahead match by backtracking — it reported a violation on the
  // correct line. The safe form is to assert that every `= memberRow` that is
  // not followed by `? memberScope(` does not exist, by scanning the matches.
  const rawHandoffs = [...rdSrc.matchAll(/const member\s*=\s*memberRow\s*(\?)?/g)]
    .filter((m) => !m[1]);
  check(
    "buildScope does not hand the raw member row to templates (rule 81a)",
    rawHandoffs.length === 0,
    `${rawHandoffs.length} raw \`= memberRow\` handoff(s) without the projection`
  );

  // Non-vacuity: the sources were actually read, and the slice found its target.
  check(
    "the rule-81 sources were actually read (non-vacuity)",
    membersSrc.length > 1000 && rdSrc.length > 5000 && scopeFn.length > 100
  );
}

// ---------------------------------------------------------------------------
section("My posts is the reader's, and only the reader's (rule 82)");
// ---------------------------------------------------------------------------

/**
 * `{{#each my_posts as post}}` on the account page is the one listing that is
 * built from an **identity** rather than from a route: the posts of the member
 * who is signed in. Three ways it can quietly answer the wrong question, each
 * of which renders a plausible page:
 *
 * 1. **Site-blind.** A member id is unique per site *today*, so
 *    `WHERE author_member_id=?` happens to be unambiguous — and that is exactly
 *    the coincidence §10 rule 6 forbids leaning on. Add one migration that
 *    makes member ids global and the query starts returning another site's
 *    posts, silently. The WHERE must carry **both** `site_id` and
 *    `author_member_id`; migration 0024 documents the pair as the invariant.
 *
 * 2. **Published-only.** The account template prints `<span class="badge">`
 *    with `{{post.status}}`. If the query filtered to `published`, that badge
 *    would render the same word on every row — decoration, not information. An
 *    author must see their drafts; the *public* listing is the one that hides
 *    them.
 *
 * 3. **Linked through the current route.** The account page is served under
 *    `/account`, so reusing the route base to build item URLs points every
 *    post at `/account/<slug>` and 404s on click. The URL must be the built-in
 *    permalink (`/{locale}/blog/{slug}`).
 *
 * These are lexical for the same reason rule 81 is: no suite here drives the
 * real `buildScope`. Each is written against the **defect shape** — the point
 * is to go red when the guarantee is dropped, not to confirm the current line
 * exists.
 */
{
  const rdSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));

  // Slice the function body rather than scanning the file: `site_id = ?` and
  // `author_member_id` both appear elsewhere (every listing filters the site),
  // so a whole-file scan would agree with code that never carried the pair.
  const fnStart = rdSrc.indexOf("async function memberPosts");
  const fnEnd = rdSrc.indexOf("async function attachMeta", fnStart);
  const fn = fnStart >= 0 ? rdSrc.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000) : "";

  check("the member-posts reader exists (rule 82, non-vacuity)", fn.length > 200);

  // 1. Both columns in the WHERE, in the same statement. Reading the two
  //    `bind`s is not enough — a bind can be passed out of order or the column
  //    dropped — so anchor on the predicate text itself.
  check(
    "the member-posts query filters on the site AND the member (rule 82a)",
    /p\.site_id\s*=\s*\?/.test(fn) && /p\.author_member_id\s*=\s*\?/.test(fn),
    "both `p.site_id = ?` and `p.author_member_id = ?` must appear in the WHERE"
  );

  // 2. No status filter. The defect is a `status = 'published'` creeping in
  //    "for consistency with the listing"; assert its absence in this reader.
  check(
    "the member-posts query does not filter to published (rule 82b)",
    !/status\s*=\s*'published'/.test(fn) && !/status\s*=\s*\?/.test(fn),
    "an author's own list must show drafts, not just live rows"
  );

  // 3. The link is the built-in permalink, not the current route's base. Anchor
  //    on the constructed URL so a later refactor to `itemUrl(...)` (which
  //    would pick up `/account`) goes red.
  check(
    "member-post links use the built-in blog permalink (rule 82c)",
    /it\.url\s*=\s*`\/\$\{locale\}\/blog\/\$\{it\.slug\}`/.test(fn),
    "a post link must be `/{locale}/blog/{slug}`, never built from the /account route"
  );

  // 4. Absent, not an empty array, with no member. `buildScope` must not
  //    compute `my_posts` unless there is a member row — otherwise a signed-out
  //    visitor renders a "0 articles" header over an empty list instead of the
  //    signed-out branch.
  check(
    "buildScope only builds my_posts for a signed-in member (rule 82d)",
    /const myPosts\s*=\s*memberRow\s*\?\s*await memberPosts\(/.test(rdSrc)
  );
  check(
    "my_posts is spread in only when present (rule 82d)",
    /\.\.\.\(myPosts\s*\?\s*\{\s*my_posts:\s*myPosts\s*\}\s*:\s*\{\}\)/.test(rdSrc)
  );
}

// ---------------------------------------------------------------------------
section("The language switcher is a dropdown (rule 83)");
// ---------------------------------------------------------------------------

/**
 * The switcher used to be a row of pills — every language spelled out in the
 * header, always visible. It is a `<details>` menu now, and the trigger has to
 * label itself with the **current language's name**.
 *
 * The template language cannot do that on its own. It has `{{#each}}` and nine
 * helpers and **no lookup**: there is no "read the item whose `current` is
 * true". Looping inside the trigger is not a workaround either — the current
 * entry sits in the middle of the list, so a `{{#if l.current}}` there would
 * print every *other* language's name alongside it. So the pick happens in
 * `buildScope`, and the guarantee to protect is that it is made from the
 * **same array** `lang_nav` comes from, by **matching** rather than position.
 *
 * ⚠️ Two lessons from writing these, both of which cost a run:
 *
 *   1. **A whole-document `includes("简体中文")` pins nothing here.** The menu
 *      lists every language by name, so a trigger switched to
 *      `{{lang_current.code}}` still finds the name *somewhere on the page*.
 *      That was this batch's first assertion, and it stayed green under the
 *      defect — "anchor on the consumer, not the mention" (§12 #16, rules
 *      69/78/79), a fourth instance. The template-side check now reads the
 *      text **inside `<summary>`**; the check below reads the pick itself.
 *   2. **A fixture whose `current: true` sits at index 0 cannot tell `find`
 *      from `[0]`.** Both agree, so the scope could pick the wrong entry and
 *      pass. `theme-bundled`'s `makeScope` puts the rendered language **in the
 *      middle** of three for exactly this reason.
 *
 * The asserts below are lexical for the same reason rules 81/82 are: no suite
 * here drives the real `buildScope`, so each is written against the **defect
 * shape** — the point is to go red when the guarantee is dropped.
 */
{
  const rdSrc = blankComments(read(join(ROOT, "src", "extensions", "theme", "runtime-declarative.ts")));

  // The pick is made from `langNavRows`, matching on `current`. Anchor on the
  // whole construction so a `find` swapped for `langNavRows[0]` (which renders
  // a plausible and wrong trigger) is caught, as is a pick made from a
  // *different* array — two arrays can disagree about which language is current.
  const pick = rdSrc.match(/const langCurrent\s*=\s*([^;]+);/);
  check("the current-language pick exists (rule 83, non-vacuity)", !!pick && pick[1].length > 10,
    "`lang_current` must be derived in buildScope — a template cannot look it up");
  const pickExpr = pick ? pick[1] : "";
  check(
    "the current language is picked by matching, not by position (rule 83a)",
    /langNavRows\.find\(\s*\(?\w+\)?\s*=>\s*\w+\.current\s*\)/.test(pickExpr),
    "`find(l => l.current)` — an index (`langNavRows[0]`) silently names the wrong language on every locale but one"
  );
  check(
    "the pick comes from the same array as lang_nav (rule 83b)",
    pickExpr.includes("langNavRows"),
    "one source, two views: picking from a second array lets the trigger and the menu disagree"
  );

  // Same gate as `lang_nav`. A monolingual site gets neither: one entry is not
  // a switcher, and an ungated `lang_current` would put a stray name in a
  // header that renders no menu at all.
  check(
    "lang_current shares lang_nav's gate (rule 83c)",
    /lang_nav:\s*langNavRows\.length\s*>\s*1\s*\?\s*langNavRows\s*:\s*\[\]/.test(rdSrc) &&
      /lang_current:\s*langNavRows\.length\s*>\s*1\s*\?\s*langCurrent\s*:\s*null/.test(rdSrc),
    "lang_current must be null under the same condition that empties lang_nav, or the two controls disagree"
  );
}

// ---------------------------------------------------------------------------
section("Front-end publishing belongs to the member, and to the session (rule 84)");
// ---------------------------------------------------------------------------

/**
 * A member may write their own posts through `/api/v1/front/posts`. That is the
 * first time the **front** identity gets a write path, and the ways it can go
 * wrong are all quiet — each one produces a 200 and a post that looks fine:
 *
 *   - the author comes from the request instead of the session (one member
 *     writes as another);
 *   - the status comes from the request (a member publishes straight to the
 *     front page);
 *   - ownership is checked with 403 (which confirms the id exists) or not at
 *     all (the write lands on a neighbour's row);
 *   - a member id is written into a **staff** column (`author_id`, or the
 *     activity log), merging two id spaces — the defect migration 0024
 *     refused.
 *
 * These are lexical for the same reason rules 81/82/83 are: no suite here
 * drives `routeFrontApi` through the worker. Each is written against the
 * **defect shape**, and each goes red when the guarantee is dropped.
 */
{
  const src = blankComments(read(join(ROOT, "src", "api.ts")));

  // Slice the function bodies: `site_id = ?` and `author_member_id` appear all
  // over `api.ts` (every listing filters the site), so a whole-file scan would
  // agree with code that never carried the pair.
  const saveStart = src.indexOf("async function saveMemberPost");
  const delStart = src.indexOf("async function deleteMemberPost", saveStart);
  const routeStart = src.indexOf("async function routeFrontApi", delStart);
  const routeEnd = src.indexOf("async function routeApi", routeStart);
  const saveFn = saveStart >= 0 ? src.slice(saveStart, delStart > 0 ? delStart : saveStart + 9000) : "";
  const delFn = delStart >= 0 ? src.slice(delStart, routeStart > 0 ? routeStart : delStart + 3000) : "";
  const routeFn = routeStart >= 0 ? src.slice(routeStart, routeEnd > 0 ? routeEnd : routeStart + 4000) : "";

  check("the member-post writer exists (rule 84, non-vacuity)", saveFn.length > 2000);
  check("the member-post deleter exists (rule 84, non-vacuity)", delFn.length > 400);

  // 84a — the identity is the session's. Reading `body.author_member_id` would
  // let a member author posts *as* someone else, and it is the exact shape a
  // well-meaning "let the client pass the author" refactor introduces.
  check(
    "the member id never comes from the request body (rule 84a)",
    !/body\.author_member_id/.test(saveFn) && !/body\.author_member_id/.test(delFn),
    "the author must be the session member; a body-supplied author is impersonation"
  );
  check(
    "every ownership predicate carries the site AND the member (rule 84a)",
    /site_id\s*=\s*\?/.test(saveFn) && /author_member_id\s*=\s*\?/.test(saveFn) &&
      /site_id\s*=\s*\?/.test(delFn) && /author_member_id\s*=\s*\?/.test(delFn),
    "a member id is unique per site today; the site filter is what keeps the query from being site-blind (rule 6)"
  );
  check(
    "the routes pass the session member id (rule 84a)",
    /saveMemberPost\(env,\s*siteId,\s*m\.id,/.test(routeFn) && /deleteMemberPost\(env,\s*siteId,\s*m\.id,/.test(routeFn),
    "the author argument must be `m.id` — the `requireMember` result, not a path or body value"
  );

  // 84b — one answer for every way an id can not be yours.
  check(
    "an unowned post answers 404, never 403 (rule 84b)",
    /ok\(\{\s*error:\s*"not found"\s*\},\s*404\)/.test(saveFn) &&
      /ok\(\{\s*error:\s*"not found"\s*\},\s*404\)/.test(delFn) &&
      !/403/.test(saveFn) && !/403/.test(delFn),
    "403 confirms the id exists on this site — the existence oracle MS-1.1 forbids"
  );

  // 84c — never invent a staff author. `author_id` is a `site_users` id space;
  // a member id in it would make every reader guess which kind it is looking at.
  check(
    "a member post is written with an empty staff author (rule 84c)",
    /INSERT INTO posts \([^)]*author_id[^)]*author_member_id[^)]*\)/.test(saveFn) &&
      /VALUES \(\?, \?, '', \?, 'post'/.test(saveFn),
    "`author_id` must be the literal '' (migration 0024) and `author_member_id` a bound session value"
  );

  // 84d — the status is the server's decision, on both write paths.
  const postUpdates = saveFn.match(/UPDATE posts SET[^"]*/g) ?? [];
  check(
    "a member submission lands as a draft, not as what the client asked for (rule 84d)",
    /'draft'/.test(saveFn) && !/body\.status/.test(saveFn),
    "reading `body.status` lets a crafted request publish itself to the front page"
  );
  check(
    "no member edit touches the status (rule 84d)",
    postUpdates.length >= 2 && postUpdates.every((s) => !/status/.test(s)),
    "an edit must not publish, and must not knock a staff-published post back to draft"
  );

  // 84e — `admin_activity.user_id` holds a staff id. Writing a member id there
  // is the "one column, two meanings" defect, in a log this time.
  check(
    "member writes do not enter the staff activity log (rule 84e)",
    !/\bactivity\(/.test(saveFn) && !/\bactivity\(/.test(delFn),
    "admin_activity is a staff log; member authorship is recorded by posts.author_member_id"
  );

  // 84f — one definition of "mine". The read path is the account page's
  // `my_posts` scope (rule 82); a second reader here would be a second answer.
  check(
    "the front API has no second 'my posts' reader (rule 84f)",
    /path === "posts" && method === "POST"/.test(routeFn) &&
      !/path === "posts" && method === "GET"/.test(routeFn),
    "the read path is `my_posts` in buildScope (rule 82) — two readers are two definitions of 'mine'"
  );
  check(
    "the member-post routes are behind the member gate (rule 84)",
    (routeFn.match(/requireMember\(env,\s*request,\s*siteId\)/g) ?? []).length >= 3,
    "every front write must go through `requireMember`, the same gate every other front endpoint uses"
  );
}

// ---------------------------------------------------------------------------
section("The front-end member surface works with no JavaScript (rule 85)");
// ---------------------------------------------------------------------------

/**
 * The member surface — register, sign in, write, delete — is rendered as plain
 * HTML forms, and the templates have always said so in comments ("no
 * JavaScript: the form POSTs straight to the front-end API and the server
 * redirects back"). Until this rule that promise was **false**: the API only
 * parsed JSON, so a real form answered `invalid_username` about a username the
 * reader *had* typed (the parse threw, the `.catch` turned it into `{}`), and
 * the redirect the comment promised never happened at all. A reader with
 * scripts disabled could not sign in.
 *
 * The mechanism that closes it is small, and every part of it fails quietly:
 *
 *   - **one body reader.** A per-endpoint `request.json()` is how the two
 *     shapes drift apart, and the drift is invisible — the endpoint answers
 *     about a field the caller did send.
 *   - **positive form identification.** "Anything that is not JSON" looks
 *     equivalent and is not: `logout` takes no body, so a script posts it with
 *     no `Content-Type` at all, and that rule would silently change its answer
 *     from a JSON body to a redirect.
 *   - **same-site redirects only.** The `redirect` field is caller-supplied in
 *     the strongest sense — anyone can link to our form with any value in it —
 *     so echoing it into `Location:` is an open redirect: a phishing page that
 *     reads as ours.
 *   - **a failure redirects too.** A browser cannot read a JSON error body, so
 *     a rejected submission has to come back as `?error=<code>`; without that
 *     the reader sees the same form again, no wiser than before.
 *
 * These are lexical for the same reason rules 81–84 are: no suite here drives
 * the real worker. Each is written against the **defect shape**, so it goes red
 * when the guarantee is dropped, not merely when a line moves.
 */
{
  const src = blankComments(read(join(ROOT, "src", "api.ts")));

  // Slice the functions: `request.json()` and `status: 303` appear elsewhere in
  // `api.ts` (every admin endpoint parses JSON), so a whole-file scan would
  // agree with code that never carried the front-end contract.
  const routeStart = src.indexOf("async function routeFrontApi");
  const routeEnd = src.indexOf("async function routeApi", routeStart);
  const routeFn = routeStart >= 0 ? src.slice(routeStart, routeEnd > 0 ? routeEnd : routeStart + 8000) : "";
  const readerStart = src.indexOf("async function readFrontParams");
  const readerFn = readerStart >= 0 ? src.slice(readerStart, readerStart + 2500) : "";
  const formStart = src.indexOf("function isFormRequest");
  const formFn = formStart >= 0 ? src.slice(formStart, formStart + 900) : "";
  const safeStart = src.indexOf("function safeRedirect");
  const safeFn = safeStart >= 0 ? src.slice(safeStart, safeStart + 900) : "";
  const answerStart = src.indexOf("async function frontAnswer");
  const answerFn = answerStart >= 0 ? src.slice(answerStart, answerStart + 2000) : "";
  const handlerStart = src.indexOf("export async function handleFrontApi");
  const handlerFn = handlerStart >= 0 ? src.slice(handlerStart, handlerStart + 5000) : "";

  check("the front body reader exists (rule 85, non-vacuity)", readerFn.length > 400);
  check("the form detector exists (rule 85, non-vacuity)", formFn.length > 100);
  check("the redirect guard exists (rule 85, non-vacuity)", safeFn.length > 100);
  check("the form answer adapter exists (rule 85, non-vacuity)", answerFn.length > 400);

  // 85a — one reader. No front endpoint may reach for `request.json()` itself:
  // that is precisely the line that made every form fail, because a form body
  // throws on `.json()` and the `.catch` swallows it into `{}`.
  check(
    "the front routes never parse the body themselves (rule 85a)",
    !/request\.json\(\)/.test(routeFn) && /readFrontParams\(request\)/.test(routeFn),
    "every front endpoint must read through `readFrontParams`; a local `request.json()` is the shape that broke the forms"
  );
  check(
    "the body reader parses what a browser sends (rule 85a)",
    /request\.formData\(\)/.test(readerFn) && formFn.includes("application/x-www-form-urlencoded"),
    "the reader must accept `application/x-www-form-urlencoded`, not only JSON"
  );

  // 85b — the shape of the answer belongs to the caller. Every read is paired
  // with an answer, so the counts must agree; a new endpoint that reads a form
  // but returns JSON is exactly the regression this pins.
  const reads = (routeFn.match(/readFrontParams\(request\)/g) || []).length;
  const answers = (routeFn.match(/frontAnswer\(/g) || []).length;
  check(
    "every form read is answered through the same adapter (rule 85b)",
    reads > 0 && answers >= reads,
    `found ${reads} read(s) and ${answers} answer(s) — a form request must not fall out as JSON`
  );
  check(
    "a form answer is a 303 (rule 85b)",
    answerFn.includes("status: 303"),
    "a browser that submitted a form must be sent somewhere, not handed a body to render"
  );

  // 85c — positive identification, never "not JSON". `logout` carries no body,
  // so a script posts it with no content type; a `!/json/` test would flip its
  // answer from JSON to a redirect and break every existing caller silently.
  check(
    "form detection is positive, never 'anything but JSON' (rule 85c)",
    formFn.includes("application/x-www-form-urlencoded") && !formFn.includes("/json/i"),
    "`!isJson` would change the answer for a caller that sent no Content-Type (logout)"
  );

  // 85d — the redirect stays on this site. `//host` is protocol-relative (a
  // different origin) and `/\host` is a path to some browsers and an authority
  // to others, so both must be refused.
  check(
    "the redirect refuses protocol-relative and backslash targets (rule 85d)",
    safeFn.includes("/^\\/(?!\\/)/") && safeFn.includes('startsWith("/\\\\")'),
    "`//host` is another origin and `/\\host` is an authority to some browsers — that is an open redirect"
  );

  // 85e — a crash answers in the caller's shape too. A form that hits a 500
  // must not be shown a JSON error page either.
  check(
    "the front handler's crash path also answers a form (rule 85e)",
    /catch/.test(handlerFn) && /isFormRequest\(request\)/.test(handlerFn),
    "a 500 must not show a reader a JSON body"
  );
}

// ---------------------------------------------------------------------------
section("This suite's own assertions can actually fail (meta-guard)");
// ---------------------------------------------------------------------------

/**
 * The eighth false-green was not in the code under test — it was in **this
 * file's own assertion spelling**. `check("…", offenders, [])` reads as "assert
 * no offenders" and asserts nothing, because `check` tests truthiness and an
 * empty array is truthy. Any such call is a guard that can never fail, and it
 * is invisible: the output says `ok` either way.
 *
 * So the spelling is banned lexically. This is deliberately a *text* check
 * rather than a structural one: the defect is a spelling, and the thing being
 * guarded is a spelling, which is the one case in this repo where text is the
 * right tool (see AGENTS.md on `theme_admin_menus`).
 *
 * ⚠️ A lexical ban only covers the spellings someone thought of, and this file
 * has now shipped three vacuous assertions in two batches: a collection as the
 * condition, a `JSON.stringify(...)` as the condition, and an array as the
 * condition with the expected value as the *detail*. The load-bearing fix is
 * therefore in `check()` itself — it now **throws** unless the condition is a
 * real boolean, which bans the whole class. The patterns below are the earlier,
 * friendlier net for the two shapes that have actually happened.
 *
 * It must not match its own source, so the pattern is assembled from parts and
 * the scan runs on the file with comments blanked (the explanatory comment
 * above contains the forbidden form as an example).
 */
{
  const selfSrc = blankComments(read(join(ROOT, "tests/suites/architecture.test.mjs")));
  const open = "check\\(";
  const arg = "\\s*\"[^\"]*\"\\s*,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*\\[\\]\\s*\\)";
  const banned = new RegExp(open + arg, "g");
  const offenders = [...selfSrc.matchAll(banned)].map((m) => m[1]);

  checkEmpty("no assertion passes a collection as its truthiness condition", offenders);

  // The same vacuity in a different spelling: a condition that is a **literal**
  // rather than a comparison. `check("…", "some string", …)` is always true for
  // exactly the reason an empty array is, and it reads as a real assertion.
  //
  // This is not hypothetical — the block-attribute guard shipped
  // `check(name, JSON.stringify(a), JSON.stringify(b))` for one run, i.e. the
  // expected and actual values handed over as the condition and the detail.
  // The injection tool caught it (`_skeleton-inject.mjs`, "the control module's
  // exported type list drifts"), *not* this section — which is why the ban is
  // now extended to cover it rather than left to the tool.
  const literalCond = /check\(\s*"(?:[^"\\]|\\.)*"\s*,\s*("(?:[^"\\]|\\.)*"|`[^`]*`|\[[^\]]*\]|\{[^{}]*\}|true)\s*,/g;
  const literalOffenders = [...selfSrc.matchAll(literalCond)].map((m) => m[1].slice(0, 48));
  checkEmpty("no assertion passes a literal as its condition", literalOffenders);

  // And prove the scan is looking at something: the file must contain the
  // helper and enough `check*` calls that a zero-result scan is meaningful.
  const checkCalls = (selfSrc.match(/\bcheck(?:Empty)?\(/g) ?? []).length;
  check(
    "the meta-guard actually scanned this suite's assertions (non-vacuity)",
    checkCalls > 20,
    `found ${checkCalls} check/checkEmpty calls`
  );
}

// ---------------------------------------------------------------------------
section("Comment markers are balanced in every source file (the blankComments trap)");
// ---------------------------------------------------------------------------

/**
 * `blankComments()` above strips block comments with a **non-greedy**
 * `/\/\*[\s\S]*?\*\//g`. That is correct for well-formed files and catastrophic
 * for a file with an *unbalanced* `/*`: one stray opener in a `//` line comment
 * (writing `` `/api/*` `` to describe a route, say) makes the next `*​/` — which
 * may be hundreds of lines away, in a genuinely unrelated `catch { /* ignore *​/ }`
 * — close a "comment" that swallowed everything between them. Every guard in
 * this file then reads a source whose middle has been blanked to whitespace,
 * and reports "anchor not found" **against correct code**.
 *
 * This has caused three separate debugging sessions, twice in the same line of
 * `src/index.ts` and once in `src/api.ts`. The failure is uniquely expensive
 * because the symptom points at the guarded code, not at the comment.
 *
 * So it is caught at the source, once, for the whole tree: in every source file
 * the number of `/*` must equal the number of `*​/`. That is not a complete
 * parser — a file could have two strays that happen to balance — but it catches
 * exactly the shape that has actually happened (a single stray opener), and it
 * costs one `npm test` assertion instead of one forensic session.
 *
 * The scan is on the **raw** source, not `blankComments`'s output: the whole
 * point is to look at what `blankComments` would have mangled.
 */
{
  const srcFiles = walk(join(ROOT, "src"), [".ts"]);
  const unbalanced = [];
  for (const f of srcFiles) {
    const raw = read(f);
    // Counts, not a regex replace: `match` with `g` returns every occurrence.
    const opens = (raw.match(/\/\*/g) ?? []).length;
    const closes = (raw.match(/\*\//g) ?? []).length;
    if (opens !== closes) unbalanced.push(`${rel(f)} (${opens} open, ${closes} close)`);
  }
  checkEmpty("every source file has the same number of /* and */", unbalanced);
  // Non-vacuity: the walk must actually see the tree, or a rename of `src/`
  // would make this pass by looking at nothing.
  check(
    "the comment-marker scan actually walked source files (non-vacuity)",
    srcFiles.length > 20,
    `walked ${srcFiles.length} files`
  );
}

// ---------------------------------------------------------------------------
section("The schema declaration covers the real database (§10 rules 41–44)");
// ---------------------------------------------------------------------------

/**
 * `tests/tools/_schema-scope.mjs` builds a throwaway SQLite from the migration
 * stream and checks every real table against `contract/schema.ts`. That is the
 * strong version of this check, but it needs `node:sqlite` and a temp dir, so
 * it is its own suite.
 *
 * What this section adds is the *cheap* structural half, runnable with zero
 * setup: the declaration must partition cleanly (no table both tenant-scoped
 * and platform-global), the derived lists must agree with the entries they are
 * derived from, and the runtime list must not overlap the platform schema.
 * A partition that overlaps is a table with two contradictory answers, which
 * is worse than no answer — a reader will believe whichever they read first.
 */
{
  const schemaSrc = read(join(ROOT, "src/extensions/contract/schema.ts"));

  const entryBlock = schemaSrc.match(/export const PLATFORM_SCHEMA\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const entryLines = entryBlock ? entryBlock[1].split("\n").filter((l) => l.includes("{ table:")) : [];

  // Parse each entry line for `table:` and `tenant:` without importing — same
  // rationale as above (this suite stays dependency-free). A line-by-line read
  // is enough because the declaration is deliberately one table per line; that
  // convention is itself asserted by the "one entry per line" count below.
  const declaredTables = entryLines.map((l) => l.match(/table:\s*"([^"]+)"/)?.[1]).filter(Boolean);
  const declaredTenants = entryLines.map((l) => l.match(/tenant:\s*"([^"]+)"/)?.[1]).filter(Boolean);

  check(
    "the schema declaration was actually parsed (non-vacuity)",
    declaredTables.length > 0,
    `${declaredTables.length} declared entries`
  );
  check(
    "every entry states a tenant scope",
    declaredTables.length === declaredTenants.length,
    `${declaredTables.length} tables vs ${declaredTenants.length} tenant values`
  );
  checkEmpty(
    "the tenant scope is only ever site or platform",
    [...new Set(declaredTenants)].filter((t) => t !== "site" && t !== "platform")
  );

  const dupTables = declaredTables.filter((t, i) => declaredTables.indexOf(t) !== i);
  checkEmpty(
    "no table is declared twice (two answers is worse than none)",
    dupTables
  );

  // Every site-scoped table must also say what happens to **its rows** when the
  // site is deleted. `deleteSite()` walks `PURGE_ON_SITE_DELETE`, derived from
  // this declaration, so an entry without a policy is a table whose rows
  // silently survive the site — which is exactly how a deleted site's admin
  // menus and generated-table mappings kept showing up in the admin. Same shape
  // as "every entry states a tenant scope" above: a declaration is only useful
  // if it is total.
  const siteLines = entryLines.filter((l) => /tenant:\s*"site"/.test(l));
  const withoutPolicy = siteLines.filter((l) => !/onSiteDelete:\s*"(?:purge|retain)"/.test(l));
  check(
    "every site-scoped table declares an onSiteDelete policy",
    siteLines.length > 0 && withoutPolicy.length === 0,
    `${siteLines.length} site-scoped entries, ${withoutPolicy.length} without a policy: ` +
      withoutPolicy.map((l) => l.match(/table:\s*"([^"]+)"/)?.[1]).join(", ")
  );
  // Non-vacuity: a policy field that is always the same value would pass the
  // check above while deciding nothing.
  const purgeCount = entryLines.filter((l) => /onSiteDelete:\s*"purge"/.test(l)).length;
  const retainCount = entryLines.filter((l) => /onSiteDelete:\s*"retain"/.test(l)).length;
  check(
    "both delete policies are actually used (non-vacuity)",
    purgeCount > 0 && retainCount > 0,
    `${purgeCount} purge / ${retainCount} retain`
  );

  // The derived exports must be derived. If someone hand-writes `TENANT_TABLES`
  // it will drift from `PLATFORM_SCHEMA` on the next edit, and the collection
  // script will agree with whichever it happens to read.
  for (const [name, filter] of [
    ["TENANT_TABLES", '"site"'],
    ["PLATFORM_TABLES", '"platform"'],
    // `deleteSite()` walks this one, so a hand-written copy would silently
    // disagree with the declaration about which rows a deleted site leaves.
    ["PURGE_ON_SITE_DELETE", '"site"'],
  ]) {
    const derivedFrom = new RegExp(
      `export const ${name}\\s*=\\s*PLATFORM_SCHEMA[\\s\\S]{0,120}?tenant\\s*===\\s*${filter}`
    ).test(schemaSrc);
    check(`${name} is derived from PLATFORM_SCHEMA, not hand-written`, derivedFrom);
  }

  // RUNTIME_TABLES describes tables the runtime owns; one of them also being a
  // declared platform table would make `scopeOf()` ambiguous.
  const runtimeBlock = schemaSrc.match(/export const RUNTIME_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const runtimeNames = runtimeBlock ? [...runtimeBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  // Settings are two-level (platform | site) and every key has to say which.
  // The declaration is a leaf module (`setting-defs.ts`) so tools can read it
  // without importing the Worker types; the *ladder* is allowed to exist in
  // exactly one module, because a second `getSetting` is a second answer to
  // "which level decided this value" — the same defect rule 70 closed for
  // `post_meta`.
  const defsPath = "src/platform/setting-defs.ts";
  const defsSrc = read(join(ROOT, defsPath));
  const scopeValues = [...defsSrc.matchAll(/scope:\s*"(platform|site)"/g)].map((m) => m[1]);
  check("the settings declaration was actually parsed (non-vacuity)", scopeValues.length > 0, `${scopeValues.length} declared key(s)`);
  check("every settings key declares a scope (platform | site)",
    scopeValues.length === [...defsSrc.matchAll(/key:\s*"/g)].length,
    `${scopeValues.length} scope(s) for ${[...defsSrc.matchAll(/key:\s*"/g)].length} key(s)`);
  const ladderDefs = [];
  for (const f of ["src/platform/settings.ts", "src/platform/frontend.ts", "src/api.ts"]) {
    if (new RegExp(`export (?:async )?function getSetting\\b`).test(read(join(ROOT, f)))) ladderDefs.push(f);
  }
  checkEmpty("the settings read ladder is defined in exactly one module", ladderDefs.filter((f) => f !== "src/platform/settings.ts"));
  check(
    "the runtime table list was parsed (non-vacuity)",
    runtimeNames.length > 0,
    `${runtimeNames.length} entries`
  );
  checkEmpty(
    "no runtime-owned table is also a declared platform table",
    runtimeNames.filter((t) => declaredTables.includes(t))
  );
}

// ---------------------------------------------------------------------------
section("Docs do not reference test suites that no longer exist");
// ---------------------------------------------------------------------------

/**
 * Documentation is executable here: AGENTS.md tells a contributor which suite
 * to run after which change, and `package.json` / the launchers are checked
 * against disk by `tests/suites/launcher-parity.test.mjs`. A doc that names a deleted
 * suite is not a cosmetic wart — it is an instruction that fails when followed,
 * and the failure looks like "the suite is broken", not "the doc is stale".
 *
 * Batch 10 deleted two theme suites and left eight references behind. They were
 * found by hand, which is the exact failure mode this repo keeps re-learning:
 * a convention nobody enforces is a convention that expires.
 *
 * Scope: only test paths written **inside a fenced code block**, and only the
 * `tests/` tree. Prose is deliberately exempt — the history section legitimately
 * quotes retired names ("`theme-aurora` was deleted in batch 10"), and a guard
 * that forbids mentioning a deleted file would forbid explaining *why* it was
 * deleted. A fenced block is the unambiguous "run this" position; prose is not.
 *
 * ⚠️ The pattern must accept the `tests/<group>/` layout: a character class that
 * stops at `/` silently matched **nothing** once the suites moved into
 * `tests/suites/`, so the existence half passed by finding zero offenders. The
 * non-vacuity counter below is what caught it — keep that counter.
 */
{
  const DOCS = [
    "AGENTS.md",
    "README.md",
    ...walk(join(ROOT, "docs"), [".md"]).map((f) => rel(f)),
  ];
  const missing = [];
  let refsScan = 0;

  for (const doc of DOCS) {
    const src = read(join(ROOT, doc));
    // Split on fences; odd-indexed chunks are the inside of a code block.
    const chunks = src.split(/^[ \t]*(?:```|~~~)[^\n]*$/m);
    const fenced = chunks.filter((_, i) => i % 2 === 1).join("\n");
    for (const m of fenced.matchAll(/\btests\/[A-Za-z0-9_./-]+\.(?:mjs|cjs)\b/g)) {
      refsScan++;
      if (!existsSync(join(ROOT, m[0]))) missing.push(`${doc}: ${m[0]}`);
    }
  }

  checkEmpty(
    "every test path named in a doc code block exists on disk",
    [...new Set(missing)]
  );
  // Non-vacuity: a rename of the docs directory would silently empty the scan
  // and the assertion above would pass by finding nothing to complain about.
  check(
    "the doc scan actually read the code blocks (non-vacuity)",
    refsScan > 5,
    `${refsScan} fenced test-path references across ${DOCS.length} docs`
  );

  // -------------------------------------------------------------------------
  // Second half: *executable commands* outside code blocks.
  // -------------------------------------------------------------------------
  //
  // The fenced-block rule above deliberately exempts prose, so that the history
  // section can quote a retired suite name while explaining why it was retired.
  // But a line of prose that says `node tests/_foo-inject.mjs` is not history —
  // it is a copy-pasteable command, and if that file was deleted the reader gets
  // `MODULE_NOT_FOUND` and blames the tooling. That is exactly how
  // `tests/_eshop-inject.mjs` survived batch 10: it was deleted, and two prose
  // lines in AGENTS.md kept telling contributors to run it.
  //
  // A bare `node <path>` is the unambiguous "run this" form in prose, so it can
  // be checked without the false positives a name-mention rule would cause.
  const runMissing = [];
  let runScan = 0;
  for (const doc of DOCS) {
    const src = read(join(ROOT, doc));
    for (const m of src.matchAll(/\bnode\s+(?:--[a-z-]+\s+)*((?:tests|scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs))/g)) {
      runScan++;
      if (!existsSync(join(ROOT, m[1]))) runMissing.push(`${doc}: node ${m[1]}`);
    }
  }
  checkEmpty(
    "every `node <path>` command written in a doc points at a file that exists",
    [...new Set(runMissing)]
  );
  check(
    "the runnable-command scan actually found commands (non-vacuity)",
    runScan > 5,
    `${runScan} node commands across ${DOCS.length} docs`
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
//
// ⚠️ This suite is the one that *documents* the sixth false-green ("no summary
// line means the run did not finish, which is not the same as success") and it
// violated that rule itself: the summary sat at the bottom of the file, so any
// throw from a guard above it produced an empty output and a non-zero exit —
// legible in CI, but exactly the shape a script grepping for `N passed, M
// failed` reads as "no failures". The post-restore check in
// `tests/tools/_skeleton-inject.mjs` walked straight into it.
//
// The fix is the one the rule prescribes: one `finish()` that always prints,
// wired to the uncaught-exception path so a crash reports as `(aborted)` and
// still carries a failure count.
let finished = false;
function finish(tag = "", extraFailures = 0) {
  if (finished) return;
  finished = true;
  const total = failed + extraFailures;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${passed} passed, ${total} failed${tag}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}`);
    console.log(
      "\nThese are architecture rules, not style preferences. See docs/ARCHITECTURE.md §5 and §10."
    );
  }
  // No second summary line. This suite used to also print
  // `${total ? "1" : "0"} failure(s)` — a different spelling of the same fact,
  // which is how a grep-based checker reads the wrong line and misses a failure
  // (AGENTS.md "false green" type 6). The `${pass} passed, ${fail} failed` line
  // printed above is the only summary.
  process.exit(total ? 1 : 0);
}
process.on("uncaughtException", (e) => {
  console.error("\nSUITE ERROR:", (e && e.stack) || e);
  finish(" (aborted)", 1);
});
process.on("unhandledRejection", (e) => {
  console.error("\nSUITE ERROR (unhandled rejection):", (e && e.stack) || e);
  finish(" (aborted)", 1);
});

finish();
