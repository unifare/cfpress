/**
 * Notification channel implementations (ARCHITECTURE.md §5.3, batch 10).
 *
 * ## Why the implementation lives in the host
 *
 * A plugin *declares* a channel (`channels[]` in `plugin.json`); the host
 * *performs* the delivery. This is not the plugin being short-changed — it is
 * the only honest shape in this runtime. A Cloudflare Worker cannot `eval`,
 * cannot `new Function`, and cannot dynamically `import` user code, so a plugin
 * that "sends" something would have to be one whose send function the host
 * loaded and ran. That is precisely the thing the capability model exists to
 * prevent.
 *
 * So a plugin's value is what it declares, what it configures, and where its
 * data lives. The delivery itself is a host behaviour, keyed by the channel
 * `code` the plugin named.
 *
 * ## The shape every implementation has
 *
 *   `send(env, siteId, pluginName, config, message)` → `ChannelSendResult`
 *
 * It never throws. A delivery that fails is a value, because the caller is a
 * hook firing on a request path: an exception here would turn "the webhook was
 * down" into "the page 500s", which is exactly the failure mode `runtime.ts`
 * guards every hook call site against.
 */
import { Env } from "../../../shared/types";
import type { ChannelMessage, ChannelSendResult } from "../../contract/channels";

export type ChannelConfig = Record<string, string>;

export type ChannelImpl = (
  env: Env,
  siteId: string,
  pluginName: string,
  config: ChannelConfig,
  message: ChannelMessage
) => Promise<ChannelSendResult>;

/**
 * How long to wait for the remote endpoint.
 *
 * A notification must not be able to hold a request open indefinitely: the
 * hook that fires it runs inline on a page render. Cloudflare's `fetch` has no
 * default timeout, so an unresponsive endpoint would stall the request until
 * the platform's own wall-clock limit.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * `webhook` — POST the message as JSON to a caller-configured URL.
 *
 * The minimum useful channel, and deliberately unopinionated about the body:
 * it sends the message plus an identifying envelope, and lets the receiver
 * decide what to do with it. Anything more specific (Slack blocks, a Feishu
 * card) is a different channel `code` with its own implementation, not a
 * special case here.
 */
const webhook: ChannelImpl = async (_env, siteId, pluginName, config, message) => {
  const url = String(config.url ?? "").trim();
  if (!url) {
    return { ok: false, error: "webhook channel has no url configured" };
  }
  // Refuse anything that is not http(s) before a request is made. A `file:`
  // or `data:` URL reaching `fetch` is at best a confusing error and at worst
  // a way to make the Worker read something it should not.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `webhook url is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `webhook url must be http(s), got "${parsed.protocol}"` };
  }

  const body = JSON.stringify({
    // The envelope identifies the source so a receiver shared by several sites
    // or plugins can tell them apart. It is additive: `payload` is whatever
    // the caller put in the message, unmodified.
    source: { site: siteId, plugin: pluginName, channel: "webhook" },
    title: message.title,
    content: message.content,
    payload: message.payload ?? {},
    dedupKey: message.dedupKey ?? null,
    sentAt: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read a little of the body for the error message — a bare status code
      // is usually not enough to tell "wrong URL" from "rejected the payload".
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `webhook responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError"
      ? `webhook timed out after ${SEND_TIMEOUT_MS}ms`
      : `webhook request failed: ${String((e as Error)?.message ?? e)}`;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The host's implementation table.
 *
 * Must stay in step with `HOST_CHANNEL_CODES` in the contract: the validator
 * accepts a plugin declaring a code from that list, and this is where the code
 * is looked up at send time. `tests/suites/architecture.test.mjs` would catch a
 * declaration that validates but cannot be delivered — that is the "declared
 * but never read" defect family, and the guard exists because it has happened
 * here before.
 */
export const CHANNEL_IMPLS: Record<string, ChannelImpl> = {
  webhook,
};

/**
 * Deliver one message through one channel, never throwing.
 *
 * An unknown `code` is a failure rather than a silent success: it means the
 * contract and the implementation table disagree, and reporting `ok` would
 * hide exactly the bug this lookup could have caught.
 */
export async function sendThroughChannel(
  env: Env,
  siteId: string,
  pluginName: string,
  code: string,
  config: ChannelConfig,
  message: ChannelMessage
): Promise<ChannelSendResult> {
  const impl = CHANNEL_IMPLS[code];
  if (!impl) {
    return { ok: false, error: `no host implementation for channel "${code}"` };
  }
  try {
    return await impl(env, siteId, pluginName, config, message);
  } catch (e) {
    // Belt and braces: an implementation should return a failure rather than
    // throw, but this is a hook call path and a throw would reach the request.
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
