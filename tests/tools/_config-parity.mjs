/**
 * Deploy-config guard: is `wrangler.local.jsonc` exactly what the generator
 * produces from `wrangler.jsonc` + `wrangler.ids.json`?
 *
 * ## Why this exists
 *
 * Two files describe one deployment. `wrangler.jsonc` is committed, carries
 * `REPLACE_WITH_*` placeholders, and is the one that gets reviewed;
 * `wrangler.local.jsonc` is gitignored, carries this account's real ids, and is
 * the one **every command runs against**. The reviewed file is not the one that
 * ships, and the shipped file is not reviewed.
 *
 * Keeping them in step by hand failed exactly once and it took two batches to
 * notice: the feature-switch `vars` block was added to the template only, so
 * the deployed Worker had no `vars` at all and the documented three-layer
 * precedence was really two. Nothing looked wrong, because an **omitted** var
 * and an explicit `"false"` both resolve to off.
 *
 * `scripts/make-local-config.mjs` removes the possibility by deriving the local
 * file. This guard is what keeps the derivation honest: it **recomputes** the
 * expected bytes with the generator's own `renderLocalConfig()` and compares
 * them to what is on disk. It deliberately does not re-describe the derivation
 * — a second description of "how the local config is built" is the same class
 * of bug one level up.
 *
 * ## Why the check is byte equality, not "the key sets match"
 *
 * Key-set comparison was the first version and it is weaker in both directions:
 * it passes when a *value* drifts (a var flipped to `"true"` by hand, an id
 * edited to the wrong resource), and it passes when a field is added to the
 * template and the local file happens to already have a key of that name. Byte
 * equality against a recomputation fails for every one of those, and it cannot
 * be satisfied by hand-maintenance at all — which is the point.
 *
 * ## Why it is a tool and not an assertion in `architecture.test.mjs`
 *
 * Both the ids file and the local config are gitignored, so both are absent on
 * a fresh clone. An assertion that skips when a file is missing is
 * green-by-absence: "perfectly derived" and "never compared" would print the
 * same result. So the derived case is checked here, loudly, and the
 * inputs-absent case is reported as **n/a — never as a pass**. The half of the
 * rule that *is* checkable from the repository alone (`varName` ↔ the template's
 * `vars` keys) lives in `architecture.test.mjs`, where it cannot be skipped.
 *
 * Usage: node tests/tools/_config-parity.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDS_PATH,
  LOCAL_PATH,
  TEMPLATE_PATH,
  placeholdersIn,
  readIds,
  renderLocalConfig,
  renderNoR2Config,
} from "../../scripts/make-local-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    failures.push(name);
  }
}

/** Strip line comments and block comments, then parse. Deliberately the same
 *  idiom the suites use — a JSONC parser dependency for two files would be a
 *  second definition of "how these configs are read". */
function readJsonc(path) {
  return JSON.parse(
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
  );
}

console.log("Deploy config (wrangler.jsonc + wrangler.ids.json -> wrangler.local.jsonc)");

const templateSrc = readFileSync(TEMPLATE_PATH, "utf8");
const template = readJsonc(TEMPLATE_PATH);

// An account-scoped id in a public repository: a D1/KV id is a UUID, and some
// Cloudflare ids are 32 hex chars. Matching the *shape* rather than a known
// value means this still works after the ids rotate.
const ID_SHAPED = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
const stringValues = (o, out = []) => {
  if (typeof o === "string") out.push(o);
  else if (Array.isArray(o)) for (const v of o) stringValues(v, out);
  else if (o && typeof o === "object") for (const v of Object.values(o)) stringValues(v, out);
  return out;
};

// -- 1. the committed template is clean --------------------------------------
// Checked against **values**, never raw source: a comment that explains the
// placeholder mechanism is documentation, and a guard that cannot tell
// documentation from configuration fails on the comment that documents it. The
// first version of this tool did exactly that.
const wanted = placeholdersIn(templateSrc);
check("the committed template still carries placeholders", wanted.length > 0, true);
check(
  "the committed template publishes no id-shaped value",
  stringValues(template).filter((v) => ID_SHAPED.test(v)),
  []
);

// -- 2. the inputs needed to derive the local file ---------------------------
const ids = readIds();
if (!ids || !existsSync(LOCAL_PATH)) {
  const what = !ids ? "wrangler.ids.json" : "wrangler.local.jsonc";
  console.log(`  n/a  ${what} is absent — the local config cannot be derived or compared`);
  console.log("");
  console.log("This is NOT a pass. Both files are gitignored, so on a fresh clone");
  console.log("there is nothing here to verify. Recreate them with:");
  console.log("");
  console.log("    node scripts/make-local-config.mjs");
  console.log("");
  console.log("The committed half of the rule (switch varName <-> the template's");
  console.log("vars keys) is asserted in tests/suites/architecture.test.mjs, which");
  console.log("cannot be skipped.");
  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// -- 3. the ids file agrees with the template, in both directions ------------
// A placeholder with no value is a deploy that cannot be generated; a value
// whose placeholder was renamed away is a value nothing reads. `renderLocalConfig`
// refuses both, so the assertion is that it does not refuse — and the message
// says which direction failed.
let rendered = null;
try {
  rendered = renderLocalConfig(templateSrc, ids);
  check("the ids file covers exactly the template's placeholders", true, true);
} catch (e) {
  check("the ids file covers exactly the template's placeholders", e.message, "<no error>");
}
check(
  "the ids file leaves no placeholder unfilled",
  wanted.filter((p) => !(p in ids)),
  []
);

// -- 4. the file on disk is the derived one ----------------------------------
// The headline check. Everything above is a diagnosis for this one failing.
check(
  "wrangler.local.jsonc is exactly what the generator produces",
  rendered === null ? "<generation failed>" : readFileSync(LOCAL_PATH, "utf8") === rendered,
  true
);
if (rendered !== null && readFileSync(LOCAL_PATH, "utf8") !== rendered) {
  console.log("       fix: node scripts/make-local-config.mjs");
}

// -- 5. the derived file is usable -------------------------------------------
const local = readJsonc(LOCAL_PATH);
check(
  "the derived file has no placeholder left",
  stringValues(local).filter((v) => v.includes("REPLACE_WITH_")),
  []
);
check(
  "the derived file carries the template's keys",
  Object.keys(local).sort(),
  Object.keys(template).sort()
);

// -- 6. the R2-less variant, when present --------------------------------------
// `wrangler.demo.jsonc` belongs to a *second* deployment (another account,
// another D1/KV), so it is derived from that account's own ids file
// (`wrangler.ids.demo.json`) rather than the shared one — otherwise it could
// only exist while the shared ids were hand-swapped, which is the drift this
// whole chain exists to prevent. Absence on either side is n/a, never a pass.
const DEMO_PATH = join(ROOT, "wrangler.demo.jsonc");
const DEMO_IDS_PATH = join(ROOT, "wrangler.ids.demo.json");
const demoIds = existsSync(DEMO_IDS_PATH) ? readIds(DEMO_IDS_PATH) : null;
if (existsSync(DEMO_PATH) && demoIds) {
  let demoRendered = null;
  try {
    demoRendered = renderNoR2Config(templateSrc, demoIds);
  } catch (e) {
    demoRendered = `<generation failed: ${e.message}>`;
  }
  check(
    "wrangler.demo.jsonc is exactly what --no-r2 derives from its own ids",
    readFileSync(DEMO_PATH, "utf8") === demoRendered,
    true
  );
  if (typeof demoRendered === "string" && !demoRendered.startsWith("<generation")) {
    const demo = JSON.parse(demoRendered.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
    check("the R2-less variant carries no r2_buckets block", "r2_buckets" in demo, false);
    check(
      "the R2-less variant keeps every other top-level key",
      Object.keys(demo).sort(),
      Object.keys(template).filter((k) => k !== "r2_buckets").sort()
    );
    check(
      "the R2-less variant fills its own ids (no placeholder left)",
      stringValues(demo).filter((v) => v.includes("REPLACE_WITH_")),
      []
    );
  }
} else {
  console.log("  n/a  wrangler.demo.jsonc / wrangler.ids.demo.json absent — no R2-less variant to compare");
}
console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("");
  console.log("Failing checks:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
