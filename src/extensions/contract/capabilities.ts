/**
 * Capabilities an extension may ask for, and the check for one.
 *
 * A capability is the unit of "what an extension is allowed to do": the
 * manifest lists them, an admin approves them at install time, and every
 * platform call the extension makes is gated on one (`host.table()` needs
 * `content.write`, `admin.register` gates menus, …).
 *
 * Kept separate from `manifest.ts` because the list has a second reader that
 * has nothing to do with manifests: the permission layer, which answers
 * "does this user hold this capability on this site". A vocabulary that both
 * the declaration surface and the runtime gate depend on belongs to neither.
 */

export const CAPABILITIES = [
  "content.read", "content.write", "settings.read", "settings.write",
  "media.read", "media.write", "routes.register", "admin.register",
  "platform.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Narrow an untrusted value to a capability.
 *
 * Exists so callers stop writing `CAPABILITIES.includes(String(x) as Capability)`
 * — that cast asserts the answer instead of checking it, and it is exactly the
 * shape of code that keeps compiling after someone renames a capability.
 */
export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}
