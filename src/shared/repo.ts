import { Env } from "./types";
import { randomId } from "./crypto";

export async function jsonBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}

export function ok(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function now() { return Math.floor(Date.now() / 1000); }

export async function activity(env: Env, userId: string | null, action: string, type?: string, id?: string, meta?: unknown) {
  await env.DB.prepare(
    "INSERT INTO admin_activity (id, user_id, action, entity_type, entity_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(await randomId(), userId, action, type ?? null, id ?? null, meta ? JSON.stringify(meta) : null, now()).run();
}
