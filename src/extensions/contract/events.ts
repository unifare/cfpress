/**
 * The domain event contract — what *happened*, as opposed to what may run (§10 rule 45).
 *
 * ## Why this is separate from `hooks.ts`
 *
 * `hooks.ts` answers "which extension points exist". This file answers "what
 * happened in the domain". Those are different questions with different
 * lifetimes, and collapsing them is how a CMS ends up with a `save_post` hook
 * that means six things depending on who fired it.
 *
 * A **hook** is a *channel*: a name the host will call.
 * An **event** is a *fact*: a past-tense statement with a payload.
 *
 * One event may be delivered over several channels; one channel may carry
 * several events. `DECLARABLE_HOOKS` has seven entries because there are seven
 * *places to attach*. `DOMAIN_EVENTS` has entries because there are that many
 * *things worth knowing about* — and a future plugin subscribing to
 * `PostPublished` should not have to reason about whether that arrives as
 * `afterSavePost` with `status === "published"`.
 *
 * ## The three properties that make this a contract
 *
 * 1. **Names are declared here, once.** A plugin's subscription is validated
 *    against `DOMAIN_EVENTS` at install, so a typo is a 400 rather than a
 *    hook that never fires. This is the same failure the `beforRender` typo had
 *    (see `hooks.ts`), and the same fix.
 * 2. **Payloads are versioned.** Adding a field is fine; renaming one is a
 *    `payloadVersion` bump, which makes the break reviewable instead of silent.
 * 3. **Events carry their own scope.** Every event names the `siteId` and, when
 *    the fact is language-specific, the `locale`. A subscriber therefore cannot
 *    be handed a fact it cannot place — which is exactly how the site-blind
 *    plugin capabilities stayed hidden.
 *
 * ## What this file deliberately does NOT do
 *
 * There is no event bus, no queue, no retry. Delivery is the host's business
 * and today it is synchronous, in-process, and lossy on error (a throwing
 * subscriber must never 500 a request — see the `try/catch` in `doAction`).
 * Declaring the *vocabulary* first is what makes adding durable delivery later
 * a change of transport rather than a change of shape.
 */

/**
 * Every domain fact the platform publishes.
 *
 * Naming: `PascalCase`, past tense, `<Aggregate><Verb>` — because the reader of
 * `PostPublished` already knows it happened, where `savePost` leaves them
 * guessing whether it fired before or after.
 */
export const DOMAIN_EVENTS = [
  // -- content --------------------------------------------------------------
  "PostCreated",
  "PostUpdated",
  "PostPublished",
  "PostUnpublished",
  "PostDeleted",
  "PostTranslationCreated",
  // -- media ----------------------------------------------------------------
  "MediaUploaded",
  "MediaDeleted",
  // -- site & language ------------------------------------------------------
  "SiteCreated",
  "SiteDeleted",
  "LocaleEnabled",
  "LocaleDisabled",
  "SiteDefaultLocaleChanged",
  // -- extensions -----------------------------------------------------------
  "ExtensionInstalled",
  "ExtensionEnabled",
  "ExtensionDisabled",
  "ThemeActivated",
  "ThemeDeactivated",
  // -- account --------------------------------------------------------------
  "UserCreated",
  "UserPasswordChanged",
  "UserDeleted",
] as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

/**
 * Payload version per event.
 *
 * Absent means version 1. Bump when a field is **removed, renamed, or changes
 * meaning** — adding an optional field does not need a bump, and pretending it
 * does trains people to ignore the number.
 */
export const EVENT_PAYLOAD_VERSIONS: Partial<Record<DomainEvent, number>> = {
  // All events are v1: nothing has shipped a breaking payload change yet.
};

/**
 * Scope every event must carry.
 *
 * `siteId` is mandatory on **every** event — an event with no tenant cannot be
 * routed, logged, or reasoned about safely. `locale` is present only when the
 * fact is language-specific (`PostPublished` is; `SiteCreated` is not), which
 * is why it is a per-event decision rather than a global requirement.
 */
export interface EventEnvelope<E extends DomainEvent = DomainEvent> {
  /** Which fact. */
  event: E;
  /** Payload shape version; see `EVENT_PAYLOAD_VERSIONS`. */
  payloadVersion: number;
  /** The tenant this fact belongs to. Never absent. */
  siteId: string;
  /** The language, when the fact is per-language. */
  locale?: string;
  /** Who caused it (`user:<id>`, `scheduler`, `plugin:<name>`). */
  actor: string;
  /** Epoch seconds. */
  at: number;
  /** Event-specific body. */
  payload: Record<string, unknown>;
}

/**
 * The word the host uses to mean "the actor was not a person".
 *
 * Kept here rather than spelled inline at each publisher, so a log reader can
 * distinguish `scheduler` from a user literally named "scheduler".
 */
export const EVENT_ACTORS = {
  system: "system",
  scheduler: "scheduler",
  /** `plugin:<name>` — a fact raised by an extension rather than the platform. */
  plugin: (name: string) => `plugin:${name}`,
  /** `user:<id>` — a fact raised by a request. */
  user: (id: string) => `user:${id}`,
} as const;

/** Which events are language-specific (carry a `locale`). */
export const LOCALE_SCOPED_EVENTS = [
  "PostPublished",
  "PostUnpublished",
  "PostTranslationCreated",
  "SiteDefaultLocaleChanged",
] as const;

/**
 * Is this a declared domain event name?
 *
 * Used by the manifest validator: an extension may only subscribe to events
 * that exist, so a misspelling fails at install instead of never firing.
 */
export function isDomainEvent(name: unknown): name is DomainEvent {
  return typeof name === "string" && (DOMAIN_EVENTS as readonly string[]).includes(name);
}

/** The version a payload for `event` is currently at. */
export function payloadVersionOf(event: DomainEvent): number {
  return EVENT_PAYLOAD_VERSIONS[event] ?? 1;
}

/**
 * Does this event carry a `locale`?
 *
 * Publishers use this to decide whether to thread a language through; the
 * architecture test uses it to check that every locale-scoped event really
 * does and every site-scoped one really does not.
 */
export function isLocaleScoped(event: string): boolean {
  return (LOCALE_SCOPED_EVENTS as readonly string[]).includes(event);
}
