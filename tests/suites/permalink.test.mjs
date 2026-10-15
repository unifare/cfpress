/**
 * Unit and contract test suite for permalink engine.
 *
 * Usage: node tests/suites/permalink.test.mjs
 */
import {
  PRESET_PERMALINKS,
  DEFAULT_PERMALINK_STRUCTURE,
  extractPermalinkTokens,
  validatePermalinkPattern,
  compilePermalinkPattern,
  buildPermalink,
  matchPermalink,
} from "../../src/platform/permalink.ts";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

function checkTruthy(name, val) {
  if (val) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name} (got ${JSON.stringify(val)})`);
  }
}

async function main() {
  console.log("permalink engine tests\n");

  // 1. extract tokens
  const tokens = extractPermalinkTokens("/%year%/%monthnum%/%day%/%postname%/");
  check("permalink: extracts tokens correctly", tokens.sort(), ["%day%", "%monthnum%", "%postname%", "%year%"]);

  // 2. validate patterns
  check("validate: PLAIN is valid", validatePermalinkPattern(PRESET_PERMALINKS.PLAIN), null);
  check("validate: POST_NAME is valid", validatePermalinkPattern(PRESET_PERMALINKS.POST_NAME), null);
  check("validate: DAY_NAME is valid", validatePermalinkPattern(PRESET_PERMALINKS.DAY_NAME), null);
  check("validate: MONTH_NAME is valid", validatePermalinkPattern(PRESET_PERMALINKS.MONTH_NAME), null);
  check("validate: NUMERIC is valid", validatePermalinkPattern(PRESET_PERMALINKS.NUMERIC), null);
  check("validate: custom /archives/%post_id% is valid", validatePermalinkPattern("/archives/%post_id%"), null);
  check("validate: /%category%/%postname%/ is valid", validatePermalinkPattern("/%category%/%postname%/"), null);

  const noIdErr = validatePermalinkPattern("/%year%/%monthnum%/");
  checkTruthy("validate: missing identifier rejected", /must contain at least/.test(noIdErr || ""));

  const badTokenErr = validatePermalinkPattern("/%foo%/%postname%/");
  checkTruthy("validate: unsupported token rejected", /Unsupported permalink token: %foo%/.test(badTokenErr || ""));

  const emptyErr = validatePermalinkPattern("");
  checkTruthy("validate: empty rejected", /cannot be empty/.test(emptyErr || ""));

  // 3. compile & match DAY_NAME
  const dayPattern = PRESET_PERMALINKS.DAY_NAME;
  const matchDay = matchPermalink(dayPattern, "/2026/03/22/sample-post/");
  check("match: day_name matched", matchDay.matched, true);
  check("match: day_name year", matchDay.params.year, "2026");
  check("match: day_name monthnum", matchDay.params.monthnum, "03");
  check("match: day_name day", matchDay.params.day, "22");
  check("match: day_name postname", matchDay.params.postname, "sample-post");

  const matchNoSlash = matchPermalink(dayPattern, "/2026/03/22/sample-post");
  check("match: day_name without trailing slash", matchNoSlash.matched, true);
  check("match: day_name without trailing slash postname", matchNoSlash.params.postname, "sample-post");

  const badMatch = matchPermalink(dayPattern, "/2026/03/sample-post");
  check("match: day_name mismatch is false", badMatch.matched, false);

  // 4. compile & match MONTH_NAME
  const monthPattern = PRESET_PERMALINKS.MONTH_NAME;
  const matchMonth = matchPermalink(monthPattern, "/2026/03/sample-post/");
  check("match: month_name matched", matchMonth.matched, true);
  check("match: month_name year", matchMonth.params.year, "2026");
  check("match: month_name monthnum", matchMonth.params.monthnum, "03");
  check("match: month_name postname", matchMonth.params.postname, "sample-post");

  // 5. compile & match NUMERIC
  const numPattern = PRESET_PERMALINKS.NUMERIC;
  const matchNum = matchPermalink(numPattern, "/archives/123");
  check("match: numeric matched", matchNum.matched, true);
  check("match: numeric post_id", matchNum.params.post_id, "123");

  const matchAlpha = matchPermalink(numPattern, "/archives/p_abc-123_xyz");
  check("match: numeric alphanumeric post_id", matchAlpha.params.post_id, "p_abc-123_xyz");

  // 6. compile & match POST_NAME
  const postNamePattern = PRESET_PERMALINKS.POST_NAME;
  const matchPostName = matchPermalink(postNamePattern, "/posts/sample-post/");
  check("match: post_name matched", matchPostName.matched, true);
  check("match: post_name slug", matchPostName.params.postname, "sample-post");

  const matchCn = matchPermalink(postNamePattern, `/posts/${encodeURI("你好-世界")}/`);
  check("match: unicode postname decoded", matchCn.params.postname, "你好-世界");

  // 7. custom structure with category & author
  const customPattern = "/%category%/%author%/%year%/%postname%/";
  const matchCustom = matchPermalink(customPattern, "/tech/alice/2026/deep-dive/");
  check("match: custom pattern matched", matchCustom.matched, true);
  check("match: custom category", matchCustom.params.category, "tech");
  check("match: custom author", matchCustom.params.author, "alice");
  check("match: custom year", matchCustom.params.year, "2026");
  check("match: custom postname", matchCustom.params.postname, "deep-dive");

  // 8. build forward URL
  const post = {
    id: "p101",
    slug: "my-first-post",
    created_at: 1774180800, // 2026-03-22T12:00:00Z
    category: "news",
    author: "bob",
  };

  check("build: DAY_NAME", buildPermalink(PRESET_PERMALINKS.DAY_NAME, post), "/2026/03/22/my-first-post/");
  check("build: MONTH_NAME", buildPermalink(PRESET_PERMALINKS.MONTH_NAME, post), "/2026/03/my-first-post/");
  check("build: NUMERIC", buildPermalink(PRESET_PERMALINKS.NUMERIC, post), "/archives/p101");
  check("build: POST_NAME", buildPermalink(PRESET_PERMALINKS.POST_NAME, post), "/posts/my-first-post/");
  check("build: PLAIN", buildPermalink(PRESET_PERMALINKS.PLAIN, post), "/?p=p101");
  check(
    "build: custom with locale",
    buildPermalink(PRESET_PERMALINKS.DAY_NAME, post, { locale: "zh-CN", isDefaultLocale: false }),
    "/zh-CN/2026/03/22/my-first-post/"
  );
  check(
    "build: default locale without prefix",
    buildPermalink(PRESET_PERMALINKS.DAY_NAME, post, { locale: "en", isDefaultLocale: true }),
    "/2026/03/22/my-first-post/"
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("Failures:", failures.join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(1);
});
