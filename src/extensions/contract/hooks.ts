/**
 * The host hook contract — the *only* thing `theme/` and `plugin/` share.
 *
 * ## Why this file exists
 *
 * A theme needs to give plugins a chance to modify its output (filter the
 * final HTML, expand shortcodes, fire `beforeRender`). The naive way to do that
 * is for the theme runtime to `import { applyFilters } from "../plugin/runtime"`.
 * That works, but it silently makes plugins a **hard dependency of every
 * theme**, and it creates a two-way coupling between two things that are
 * supposed to be independently installable — which is exactly what
 * `tests/suites/architecture.test.mjs` forbids ("theme/ and plugin/ do not import each
 * other").
 *
 * So the dependency is inverted:
 *
 *   - this file declares *what a hook dispatcher looks like*, and depends on
 *     nothing but the shared types;
 *   - `theme/` depends on **this file**, not on `plugin/`;
 *   - `plugin/` implements it;
 *   - `index.ts` — the one layer allowed to know everybody — wires the two
 *     together and injects the implementation.
 *
 * ## The consequence for callers
 *
 * `theme/` never boots the plugin runtime itself. It calls
 * `hooks.applyFilters(...)` on whatever it was given. If nothing was injected
 * it uses `NULL_HOOKS`, which is a valid, working dispatcher that simply has no
 * extensions registered. That is the same behaviour as a site with no plugins
 * installed — no special case, no null checks at the call site.
 */
import type { Env } from "../../shared/types";

/**
 * Which hooks a plugin manifest may declare.
 *
 * This is a **contract**, not an implementation detail, which is why it lives
 * here rather than next to `HOOK_IMPLS`. Two readers depend on it and neither
 * may see the other: the manifest validator (refusing a hook the host will
 * never call) and the plugin runtime (which supplies the implementation). A
 * plugin that declares `beforRender` used to install cleanly, enable cleanly,
 * and then do nothing at all — the runtime filtered unknown names away and
 * nothing anywhere said so. The typo is now an install error.
 *
 * `tests/suites/architecture.test.mjs` pins this list against `HOOK_IMPLS`, so the
 * contract and the implementation cannot drift apart.
 */
export const DECLARABLE_HOOKS = [
  "beforeRender",
  "html",
  "head",
  "beforeSavePost",
  "afterSavePost",
  "beforeDeletePost",
  "shortcode",
] as const;

export type DeclarableHook = (typeof DECLARABLE_HOOKS)[number];

/** Context handed to every hook, mirroring the plugin runtime's own shape. */
export interface HookContext {
  env: Env;
  siteId: string;
}

/** A registered action or filter implementation. */
export type Hook = (ctx: HookContext, data: any) => any | Promise<any>;

/**
 * What a theme (or anything else in the extension layer) needs from the
 * plugin subsystem. Deliberately small: only what is actually consumed.
 */
export interface HostHooks {
  /** Fire a side-effecting hook. Errors must never propagate. */
  doAction(name: string, ctx: HookContext, data?: any): Promise<void>;
  /** Run a value through a filter chain, returning the transformed value. */
  applyFilters(name: string, ctx: HookContext, data: any): Promise<any>;
  /**
   * Expand `[shortcode]...[/shortcode]` occurrences in rendered HTML.
   *
   * `siteId` is required, not optional. A shortcode can resolve site-scoped
   * data (`[site_title]` reads `settings`), so a call without a site either
   * renders another tenant's value or silently falls back — and the fallback
   * is the kind of "looks fine in dev" default §10 rule 6 forbids.
   */
  renderShortcodes(env: Env, html: string, siteId: string): Promise<string>;
  /** Ensure the plugin runtime is loaded for this isolate. Idempotent. */
  boot(env: Env): Promise<unknown>;
}

/**
 * The no-op dispatcher.
 *
 * Used before `index.ts` has injected the real one, and in tests that render a
 * theme without caring about plugins. It is intentionally *not* `null`: a theme
 * calling `hooks.applyFilters(...)` gets its input back unchanged, so there is
 * no branching at call sites and no way to forget a null check.
 */
export const NULL_HOOKS: HostHooks = {
  async doAction() {},
  async applyFilters(_name, _ctx, data) {
    return data;
  },
  async renderShortcodes(_env, html, _siteId) {
    return html;
  },
  async boot() {
    return [];
  },
};

/**
 * The process-wide dispatcher, injected once by `index.ts` at boot.
 *
 * ## Why a module-level slot rather than a parameter
 *
 * `index.ts` is the only layer that may import both `theme/` and `plugin/`, so
 * it is the only place the two can be joined. Threading a `HostHooks` argument
 * through every `renderThemePage` call would spread that knowledge outward and
 * force every intermediate function to carry a parameter it does not use.
 *
 * A module-level slot keeps the wiring in exactly one place while leaving the
 * theme layer dependent only on the *interface*. `setHostHooks` is called
 * during boot; until then `NULL_HOOKS` keeps rendering correct.
 *
 * The slot is **not** a caching hazard: it is a stable reference set once per
 * isolate, unlike a `WorkerStub` (see MEMORY.md on request-scoped stubs).
 */
let current: HostHooks = NULL_HOOKS;

/** Install the real dispatcher. Called once from `index.ts` at boot. */
export function setHostHooks(hooks: HostHooks): void {
  current = hooks;
}

/** The dispatcher in effect. Never null — falls back to `NULL_HOOKS`. */
export function hostHooks(): HostHooks {
  return current;
}

/**
 * Restore the no-op dispatcher.
 *
 * For tests that enable and disable plugins within one process and must not
 * leak a previous case's registrations into the next.
 */
export function resetHostHooks(): void {
  current = NULL_HOOKS;
}
