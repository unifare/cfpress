/**
 * The notification-channel contract (ARCHITECTURE.md §5.3, batch 10).
 *
 * ## What a channel is, and who does what
 *
 * A channel is one way of delivering a notification — a webhook POST, an email.
 * The split of responsibility is the same dependency inversion the rest of this
 * directory uses:
 *
 *   the *specification* lives here (host)
 *   the *declaration* lives in `plugin.json` (plugin: "I provide `webhook`")
 *   the *implementation* lives in the host (`extensions/plugin/channels/`)
 *   the *configuration* lives in the database (per plugin, per site)
 *
 * A plugin never sends anything. It says which channels it offers and what
 * settings each one needs; the host reads that, renders a settings form from it,
 * and performs the send. In a no-build Workers runtime this is not a limitation
 * being worked around — it is the only honest shape: a plugin cannot execute
 * code in the host process, so anything it "does" has to be something the host
 * does on its behalf.
 *
 * ## Why `dedupKey` is in the contract rather than left to plugins
 *
 * The most common real bug in notification code is sending the same event twice
 * — a retry, two concurrent requests, a hook that fires more than once. Every
 * plugin would invent its own half-solution; putting the key in the contract
 * means the host does the deduplication once, for everyone.
 *
 * ## The closed type sets
 *
 * `ChannelConfigField.type` and the block types in `manifest.ts` are closed
 * sets for the same reason `ALLOWED_TABLE_FIELD_TYPES` is: the admin form is
 * *generated* from the declaration, so a type with no control renders an empty
 * input and looks like broken data. Add a type here and you must add its
 * control — `tests/suites/architecture.test.mjs` matches the two lists up.
 */

/**
 * One configuration input a channel needs.
 *
 * `key` is what the host stores; `labelKey` is a dictionary key, never literal
 * prose (§10 rule 11 — `plugin.{name}.…`), so the settings form translates.
 */
export interface ChannelConfigField {
  key: string;
  labelKey: string;
  type: ChannelFieldType;
  required?: boolean;
  /** Help text, as a dictionary key for the same reason as `labelKey`. */
  helpKey?: string;
}

/**
 * The types a channel configuration field may take.
 *
 * Each one maps to exactly one admin control (`public/admin/js/plugin-page.js`):
 * text → text input, password → masked input, url → text input with URL
 * validation, number → numeric input, boolean → checkbox.
 */
export const ALLOWED_CHANNEL_FIELD_TYPES = ["text", "password", "url", "number", "boolean"] as const;
export type ChannelFieldType = (typeof ALLOWED_CHANNEL_FIELD_TYPES)[number];

/**
 * A channel a plugin declares it can deliver through.
 *
 * Note there is no `send`, no `handler`, no `entry` — those would be executable
 * code, which a plugin may not ship (rule 48). The channel *name* is the link:
 * the host looks `code` up in its own implementation table.
 */
export interface NotificationChannel {
  /** Stable id, globally unique, matched against the host's implementation table. */
  code: string;
  /** Dictionary key for the display name (rule 11 prefix). */
  labelKey: string;
  configSchema: ChannelConfigField[];
}

/**
 * Channels the host can actually deliver through.
 *
 * A plugin may only declare a `code` from this list: declaring one the host
 * cannot deliver would put a selectable option in the admin that fails at send
 * time, which is a promise the platform has not kept.
 *
 * `payment` is absent because v0.8 implements notification only — and an
 * unimplemented channel left in the list "is promising a capability that does
 * not exist", which is the repo's existing criterion for removing an option
 * rather than stubbing it.
 *
 * `mail` was removed for the same reason at the time it was written: the host
 * has no mail binding, so a channel the admin could select would never send
 * anything on any deployment. It goes back in when there is a transport to put
 * behind it, not before. `webhook` is the abstracted minimum that works
 * everywhere, which is why it is the one that ships.
 */
export const HOST_CHANNEL_CODES = ["webhook"] as const;

/** A notification about to be sent. Field names follow the reference design. */
export interface ChannelMessage {
  title: string;
  content: string;
  payload: Record<string, unknown>;
  /**
   * Idempotency key. Two messages with the same key are sent once. Absent means
   * "no dedup" — the caller either has no natural key or does not want one.
   */
  dedupKey?: string;
}

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
  /** True when the send was skipped because `dedupKey` had already been seen. */
  deduped?: boolean;
}

/**
 * Does the host implement this channel code?
 *
 * Both the validator and the runtime ask this. One function, so a manifest that
 * validates can never fail at send time for the same reason.
 */
export function isHostChannelCode(code: string): boolean {
  return (HOST_CHANNEL_CODES as readonly string[]).includes(code);
}

/**
 * Is this a type the admin has a control for?
 *
 * Same reasoning as `isProseFieldType`: one answer, asked by the validator, the
 * architecture test and the SPA, rather than three lists that drift.
 */
export function isChannelFieldType(type: string): boolean {
  return (ALLOWED_CHANNEL_FIELD_TYPES as readonly string[]).includes(type);
}
