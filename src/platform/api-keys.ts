/**
 * API Key authentication and management for AI Agents and automation.
 *
 * Keys follow the format: `cfp_live_<24 base64url characters>`.
 * The database only stores `SHA-256(secret_token)` to prevent credential leakage.
 */
import { Env, SessionUser } from "../shared/types";
import { randomId } from "../shared/crypto";

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string; // JSON array of string
  sites: string;  // JSON array of string
  status: "active" | "revoked";
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface ApiKeyCreatedResult {
  id: string;
  name: string;
  token: string;
  keyPrefix: string;
  scopes: string[];
  sites: string[];
  createdAt: number;
}

/** Compute lowercase hex SHA-256 without byteOffset or pool slicing issues. */
async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate a Bearer token and resolve the bound SessionUser.
 * Returns null if not a valid/active API Key.
 */
export async function authenticateApiKey(
  env: Env,
  token: string
): Promise<SessionUser | null> {
  const clean = String(token || "").trim();
  if (!clean.startsWith("cfp_live_")) return null;

  const hash = await hashToken(clean);
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(`
    SELECT k.id AS key_id, k.user_id, k.scopes, k.sites, k.expires_at, k.status,
           u.id, u.username, u.email, u.role, u.status AS user_status
    FROM api_keys k
    JOIN site_users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.status = 'active' AND u.status = 'active'
    LIMIT 1
  `).bind(hash).first<any>();

  if (!row) return null;

  // Check expiration
  if (row.expires_at && Number(row.expires_at) < now) {
    return null;
  }

  // Parse scopes and sites
  let scopes: string[] = ["*"];
  let sites: string[] = ["*"];
  try {
    const s = JSON.parse(row.scopes);
    if (Array.isArray(s)) scopes = s.map(String);
  } catch {}
  try {
    const st = JSON.parse(row.sites);
    if (Array.isArray(st)) sites = st.map(String);
  } catch {}

  // Update last_used_at asynchronously
  env.DB.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?")
    .bind(now, row.key_id)
    .run()
    .catch(() => {});

  return {
    id: String(row.id),
    username: String(row.username),
    email: row.email ? String(row.email) : null,
    role: String(row.role),
    status: String(row.user_status),
    sessionId: `apikey_${row.key_id}`,
    apiKeyId: String(row.key_id),
    scopes,
    sites,
  };
}

/**
 * Generate a new API key.
 * Only returns the cleartext token once upon creation.
 */
export async function createApiKey(
  env: Env,
  userId: string,
  name: string,
  scopes: string[] = ["*"],
  sites: string[] = ["*"],
  expiresInDays: number | null = null
): Promise<ApiKeyCreatedResult> {
  const cleanName = String(name || "").trim() || "AI Integration Key";
  const id = `ak_${await randomId(12)}`;
  const secretPart = await randomId(24);
  const token = `cfp_live_${secretPart}`;
  const keyPrefix = token.slice(0, 14); // e.g. "cfp_live_a1b2c"
  const keyHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresInDays && expiresInDays > 0 ? now + expiresInDays * 86400 : null;

  const scopesJson = JSON.stringify(scopes.length ? scopes : ["*"]);
  const sitesJson = JSON.stringify(sites.length ? sites : ["*"]);

  await env.DB.prepare(`
    INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes, sites, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(id, userId, cleanName, keyPrefix, keyHash, scopesJson, sitesJson, expiresAt, now).run();

  return {
    id,
    name: cleanName,
    token,
    keyPrefix,
    key_prefix: keyPrefix,
    scopes,
    sites,
    createdAt: now,
    created_at: now,
  };
}

/**
 * List API keys (without secret tokens) for the current user or superadmin.
 */
export async function listApiKeys(env: Env, userId?: string): Promise<Omit<ApiKeyRecord, "key_hash">[]> {
  const query = userId
    ? "SELECT id, user_id, name, key_prefix, scopes, sites, status, expires_at, last_used_at, created_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC"
    : "SELECT id, user_id, name, key_prefix, scopes, sites, status, expires_at, last_used_at, created_at FROM api_keys ORDER BY created_at DESC";

  const stmt = userId ? env.DB.prepare(query).bind(userId) : env.DB.prepare(query);
  const rows = await stmt.all<any>();
  return (rows.results as any[]) ?? [];
}

/**
 * Revoke an API key.
 */
export async function revokeApiKey(env: Env, keyId: string, userId?: string): Promise<boolean> {
  const query = userId
    ? "UPDATE api_keys SET status='revoked' WHERE id=? AND user_id=?"
    : "UPDATE api_keys SET status='revoked' WHERE id=?";

  const stmt = userId ? env.DB.prepare(query).bind(keyId, userId) : env.DB.prepare(query).bind(keyId);
  const res = await stmt.run();
  return (res.meta?.changes ?? 0) > 0;
}
