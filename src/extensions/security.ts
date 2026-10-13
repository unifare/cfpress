/**
 * Handling untrusted input: zip paths and hashing.
 *
 * The manifest rules used to live here too, but they moved to
 * `contract/validation.ts` and `contract/manifest.ts` — the vocabularies they
 * depend on (allowed screens, field types) have other readers, and a file that
 * both defines a vocabulary and polices it cannot be shared without copying.
 *
 * What is left is what the name promises: the checks applied to bytes that came
 * from outside, before anything else looks at them.
 */

/**
 * Is this path safe to write into R2 / read out of a zip?
 *
 * The whole point is `..`: an uploaded package is a zip of attacker-chosen
 * names, and one entry called `../../index.ts` would otherwise overwrite the
 * Worker's own source at deploy time. Backslashes and a leading `/` are refused
 * for the same reason on Windows-style archives and absolute entries, and the
 * NUL check because a truncated name is a name that is not what it appears.
 */
export function safeZipPath(path: string): boolean {
  return !!path && path.length <= 240 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").includes("..") && !path.includes("\0");
}

/** Lowercase hex SHA-256 of a buffer, used for extension integrity records. */
export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
