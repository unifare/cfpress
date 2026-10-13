/**
 * Host-side notification delivery: config lookup, dedup, send, log.
 *
 * `channels/index.ts` knows how to talk to one endpoint. This module is the
 * policy around that: which configuration to use, whether this message has
 * already been sent, and where the attempt gets recorded.
 *
 * ## Why the dedup check and the insert are one statement
 *
 * The naive shape is "SELECT, then send, then INSERT" — which is racy by
 * construction: two concurrent requests both find nothing, both send, and the
 * duplicate the `dedupKey` existed to prevent happens anyway. The uniqueness is
 * therefore expressed in the schema (a partial unique index on
 * `(site_id, plugin_name, channel, dedup_key)`) and claimed *before* sending,
 * with the send result written back afterwards.
 *
 * The trade-off is deliberate: a claim that is made and then fails still blocks
 * a later retry with the same key. That is the safe direction for a
 * notification — sending once too few beats sending twice — and the recorded
 * row carries the error, so the failure is visible in the plugin's log page
 * rather than silent.
 */
import { Env } from "../../shared/types";
import { now } from "../../shared/repo";
import { randomId } from "../../shared/crypto";
import type { ChannelMessage, ChannelSendResult } from "../contract/channels";
import { sendThroughChannel, type ChannelConfig } from "./channels/index";

/**
 * Read a channel's configuration for one plugin.
 *
 * Channel settings are ordinary plugin settings, namespaced `channel.<code>.`
 * so a plugin's own settings and its channel settings cannot collide. Returns
 * only keys the schema declared — a stored key with no declaration is ignored,
 * the same way `tableSave` drops undeclared fields: a caller's rows must not
 * become configuration.
 */
export async function readChannelConfig(
  env: Env,
  pluginName: string,
  code: string,
  declaredKeys: string[]
): Promise<ChannelConfig> {
  const out: ChannelConfig = {};
  if (!declaredKeys.length) return out;
  try {
    const r = await env.DB.prepare(
      "SELECT key, value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1) AND key LIKE ?"
    )
      .bind(pluginName, `channel.${code}.%`)
      .all();
    const stored = new Map<string, string>(
      (((r.results as any[]) ?? []) as any[]).map((row) => [String(row.key), String(row.value ?? "")])
    );
    for (const key of declaredKeys) {
      const value = stored.get(`channel.${code}.${key}`);
      if (value !== undefined) out[key] = value;
    }
  } catch {
    // Table missing on a very old database; an empty config makes the channel
    // report "not configured", which is the correct answer.
  }
  return out;
}

/**
 * Deliver one message and record the attempt.
 *
 * Returns `deduped: true` without sending when the key has been used before.
 */
export async function deliverNotification(
  env: Env,
  siteId: string,
  pluginName: string,
  code: string,
  config: ChannelConfig,
  message: ChannelMessage
): Promise<ChannelSendResult> {
  const ts = now();
  const id = `ntf_${await randomId()}`;

  // Claim the dedup key, if there is one. The partial unique index is what
  // makes this a claim rather than a check.
  if (message.dedupKey) {
    try {
      await env.DB.prepare(
        `INSERT INTO notification_log(id,site_id,plugin_name,channel,dedup_key,title,content,payload,ok,error,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          id, siteId, pluginName, code, String(message.dedupKey),
          String(message.title ?? ""), String(message.content ?? ""),
          JSON.stringify(message.payload ?? {}), 0, "pending", ts
        )
        .run();
    } catch {
      // The insert lost the race (or the key was already used). Either way this
      // message has been handled, so it is not sent again.
      return { ok: true, deduped: true };
    }
  }

  const result = await sendThroughChannel(env, siteId, pluginName, code, config, message);

  try {
    if (message.dedupKey) {
      // Update the claim we already made with the real outcome.
      await env.DB.prepare("UPDATE notification_log SET ok=?, error=? WHERE id=?")
        .bind(result.ok ? 1 : 0, result.error ?? null, id)
        .run();
    } else {
      // No key: nothing to claim, so the row is written after the fact.
      await env.DB.prepare(
        `INSERT INTO notification_log(id,site_id,plugin_name,channel,dedup_key,title,content,payload,ok,error,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          id, siteId, pluginName, code, null,
          String(message.title ?? ""), String(message.content ?? ""),
          JSON.stringify(message.payload ?? {}), result.ok ? 1 : 0, result.error ?? null, ts
        )
        .run();
    }
  } catch {
    // Logging must never change the outcome of a send that already happened.
  }

  return result;
}
