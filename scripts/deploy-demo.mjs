/**
 * Re-deploy the FROZEN demo (`cfpress-demo`, the R2-less account).
 *
 * The demo is frozen at a tag (`demo-frozen-*`): this script refuses to run
 * unless HEAD is exactly that tag, so new development on `main` can never
 * leak into the demo by accident. To re-deploy the demo while `main` has
 * moved on, check the tag out in a separate worktree (which also needs a
 * copy of the gitignored `wrangler.ids.demo.json`) and run this there:
 *
 *   git worktree add ../cfpress-demo-frozen demo-frozen-2026-10-15
 *   cp wrangler.ids.demo.json ../cfpress-demo-frozen/
 *   cd ../cfpress-demo-frozen && npm run deploy:demo
 *
 * Required environment (never embedded here — the token is a secret, and the
 * account id selects whose resources get touched):
 *   CLOUDFLARE_API_TOKEN     token for the demo account
 *   CLOUDFLARE_ACCOUNT_ID    must equal DEMO_ACCOUNT_ID below
 *
 * Exit codes: 0 ok · 1 frozen-tag mismatch or missing environment.
 */
import { execSync } from "node:child_process";

const TAG = "demo-frozen-2026-10-15";
const DEMO_ACCOUNT_ID = "98b315ef540aae2e8225dbee61c9c5e2";
const DEMO_WORKER_NAME = "cfpress-demo";

function out(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

const head = out("git rev-parse HEAD");
let tagged = null;
try {
  tagged = out(`git rev-list -n 1 ${TAG}`);
} catch {
  console.error(`deploy-demo: tag ${TAG} does not exist in this clone.`);
  process.exit(1);
}
if (head !== tagged) {
  console.error(
    `deploy-demo: REFUSED — HEAD (${head}) is not the frozen demo ` +
      `(${TAG} = ${tagged}).\n` +
      `The demo stays as it is; deploy it from a worktree checked out at the tag.`
  );
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error("deploy-demo: REFUSED — CLOUDFLARE_API_TOKEN is not set.");
  process.exit(1);
}
if (process.env.CLOUDFLARE_ACCOUNT_ID !== DEMO_ACCOUNT_ID) {
  console.error(
    `deploy-demo: REFUSED — CLOUDFLARE_ACCOUNT_ID must be ${DEMO_ACCOUNT_ID} ` +
      `(got ${JSON.stringify(process.env.CLOUDFLARE_ACCOUNT_ID ?? null)}). ` +
      `This guard keeps the demo deploy off your real account.`
  );
  process.exit(1);
}

run("node scripts/make-local-config.mjs --no-r2 --ids wrangler.ids.demo.json --out wrangler.demo.jsonc");
run("wrangler d1 migrations apply cfpress --remote -c wrangler.demo.jsonc");
run(`wrangler deploy --name ${DEMO_WORKER_NAME} -c wrangler.demo.jsonc`);
console.log(`deploy-demo: ${DEMO_WORKER_NAME} re-deployed from ${TAG}.`);
