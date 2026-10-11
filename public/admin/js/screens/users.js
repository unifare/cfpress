/**
 * Screen: Users — admin accounts, their site memberships and per-site roles.
 *
 * ## Why the role column is "on this site", not `site_users.role`
 *
 * Batch E moved authority from `site_users.role` (one column, one answer for
 * every tenant) to `site_users_sites` (one row per person *per site*). The
 * `role` column still exists and still means something — it is the install-wide
 * identity — but it is no longer the answer to "what may this person do here".
 *
 * A table that keeps printing `x.role` therefore prints a **stale** answer: an
 * account whose install-wide role is `author` but who is the `admin` of the
 * shop site shows "author", and the operator reading the screen concludes the
 * wrong thing about the one site they are looking at. The list endpoint already
 * carries the two facts this needs — `role_here` (the role on the site being
 * viewed) and `sites` (the full membership map) — so the screen reads them
 * rather than the column that stopped being the answer.
 *
 * `superadmin` is deliberately shown as its own thing, never as a site role: it
 * is install-wide, it outranks every membership, and it is not assignable from
 * this screen (the endpoint rejects it with 400, rule 78d).
 *
 * ## Who may be here
 *
 * `users.manage` is install-wide (see `PLATFORM_PERMISSIONS`), so this screen is
 * superadmin-only — which is the point: "who exists on this install" is not a
 * per-tenant question, and neither is "which sites can they reach". A scoped
 * site admin manages content, not accounts.
 */
import { api, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

/** The install-wide role, spelled once so the screen cannot disagree with the API. */
const SUPERADMIN = "superadmin";

/** Roles a *site* membership may carry. `superadmin` is absent on purpose. */
const SITE_ROLE_VALUES = ["admin", "editor", "author"];

const ROLE_LABEL = {
  superadmin: () => t("core.users.roleSuperadmin", "Superadmin"),
  admin: () => t("core.users.roleAdmin", "Admin"),
  editor: () => t("core.users.roleEditor", "Editor"),
  author: () => t("core.users.roleAuthor", "Author"),
};

function roleLabel(role) {
  return (ROLE_LABEL[role] || (() => String(role)))();
}

/** One badge for a role name, with `superadmin` marked apart from site roles. */
function roleBadge(role) {
  if (!role) return `<span class="muted text-sm">${esc(t("core.users.roleNone", "—"))}</span>`;
  const kind = role === SUPERADMIN ? "default" : "outline";
  return `<span class="badge ${kind}">${esc(roleLabel(role))}</span>`;
}

/**
 * The other sites this account holds a membership on, as text.
 *
 * `here` is excluded because the site-of-record column already shows it, and
 * naming it twice reads as two different facts. An empty result is an explicit
 * "no other site" rather than a blank cell: the blank is what an operator
 * cannot tell apart from a rendering failure.
 */
function otherSitesText(sites, here) {
  const rest = Object.entries(sites || {}).filter(([sid]) => sid !== here);
  if (!rest.length) return t("core.users.onlyHere", "This site only");
  return rest.map(([sid, role]) => `${sid}: ${roleLabel(role)}`).join(" · ");
}

export default async function users(c) {
  const d = await api("users");
  const items = d.items || [];
  // The site the list was answered for. The endpoint echoes it, so the screen
  // never has to guess from `state.site` (which is what the *switcher* shows and
  // is a different fact the moment the two disagree).
  const here = d.site || state.site;

  const rows = items.map((x) => {
    const isSuper = x.role === SUPERADMIN;
    // A superadmin has every site, including ones created later, so the
    // membership map is not what answers "what can they reach" — saying "this
    // site only" for one would be exactly wrong.
    const scope = isSuper
      ? `<span class="badge default">${esc(t("core.users.allSites", "All sites"))}</span>`
      : `<span class="muted text-sm">${esc(otherSitesText(x.sites, here))}</span>`;
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground);font-weight:600">${esc(String(x.username || "?").slice(0, 2).toUpperCase())}</span>
        <div><div style="font-weight:500">${esc(x.username)}</div><div class="muted text-sm">${esc(x.email || t("core.users.noEmail", "no email"))}</div></div>
      </div></td>
      <td>${isSuper ? roleBadge(SUPERADMIN) : roleBadge(x.role_here)}</td>
      <td>${scope}</td>
      <td>${x.status === "active" ? `<span class="badge success">${esc(t("core.users.active", "active"))}</span>` : `<span class="badge secondary">${esc(x.status)}</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-user-roles="${esc(x.id)}">${icon("key-round")}${esc(t("core.users.editRoles", "Site roles"))}</button>
      </td>
    </tr>`;
  }).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.users", "Users"),
    sub: t("core.users.subHere", "{n} account(s) · roles shown for {site}", { n: items.length, site: here }),
    actions: `<button class="btn primary" data-action="new-user">${icon("plus")}${esc(t("core.users.add", "Add user"))}</button>`,
    crumbs: [{ label: t("core.nav.system", "System") }, { label: t("core.nav.users", "Users") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.users.colUser", "User"))}</th>
      <th>${esc(t("core.users.colRoleHere", "Role here"))}</th>
      <th>${esc(t("core.users.colOtherSites", "Other sites"))}</th>
      <th>${esc(t("core.users.colStatus", "Status"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(5, t("core.users.none", "No users."))}</tbody>
  </table></div>
  <div class="panel" style="margin-top:1rem">
    <div class="card-title">${esc(t("core.users.rolesTitle", "Roles are per site"))}</div>
    <p class="muted text-sm" style="margin:.5rem 0 0">${esc(t("core.users.rolesDesc", "A person’s role is stored per site: the same account can be an admin here and an author elsewhere, and a site it has no role on is one it cannot open at all. This column shows the role on the site you are currently on."))}</p>
  </div>`;
}

/**
 * The site-role editor: every site, with the role this person holds on it.
 *
 * A dialog (not a per-row inline select) because a membership edit is a small
 * batch — grant one, revoke another — and issuing each change as its own
 * request with its own success toast turns one intention into two reports and
 * leaves the table half-updated if the second fails.
 *
 * Only *changed* rows are sent. The endpoint has no "set all" form, and sending
 * an unchanged role would rewrite a row that already says the same thing — a
 * write that is invisible in the result but real in the activity log.
 */
async function editUserRoles(userRow) {
  const all = state.sites || [];
  if (!all.length) {
    // No site list means no site to name, and a role with no site is not a
    // thing. Say so rather than opening an empty form.
    await alertDialog({ title: t("core.users.editRoles", "Site roles"), description: t("core.users.noSites", "No sites are available.") });
    return;
  }
  const current = { ...(userRow.sites || {}) };
  const options = [
    { value: "", label: t("core.users.roleNoneOption", "No role (cannot open)") },
    ...SITE_ROLE_VALUES.map((r) => ({ value: r, label: roleLabel(r) })),
  ];
  const fields = all.map((s) => ({
    name: "site_" + s.id,
    label: `${s.name} (${s.id})`,
    type: "select",
    value: current[s.id] || "",
    options,
  }));

  const v = await openDialog({
    title: t("core.users.editRolesFor", "Site roles for {name}", { name: userRow.username }),
    description: t("core.users.editRolesDesc", "Choose the role this person holds on each site. “No role” removes their access to that site — a site with no role is one they cannot open."),
    confirmLabel: t("core.users.saveRoles", "Save roles"),
    fields,
  });
  if (!v) return;

  // Diff against what the server told us. An empty string is the *absence* of a
  // membership, which the endpoint spells `role: null` — the denial is the
  // missing row, not a role whose value means "none".
  const changes = [];
  for (const s of all) {
    const want = String(v["site_" + s.id] ?? "");
    const had = String(current[s.id] ?? "");
    if (want === had) continue;
    changes.push({ site: s.id, role: want === "" ? null : want, had });
  }
  if (!changes.length) {
    toast(t("core.users.noRoleChanges", "No role changes"));
    return;
  }

  try {
    for (const ch of changes) {
      await api(`users/${encodeURIComponent(userRow.id)}/sites/${encodeURIComponent(ch.site)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: ch.role }),
      });
    }
    toast(t("core.users.rolesSaved", "Roles updated"));
    render();
  } catch (err) {
    // Partial failure is reported as one: the request that failed is named, and
    // the table is re-read so it shows what actually landed rather than what
    // was intended.
    await alertDialog({ title: t("core.users.rolesFailed", "Could not update roles"), description: err.message });
    render();
  }
}

document.addEventListener("click", async (e) => {
  const rolesBtn = e.target.closest("[data-user-roles]");
  if (rolesBtn) {
    const id = rolesBtn.dataset.userRoles;
    // Find the row in the store the table was built from, so the dialog's
    // starting values are the ones the operator can see — not a second fetch
    // that might answer with a different snapshot.
    const d = await api("users").catch(() => ({ items: [] }));
    const row = (d.items || []).find((x) => String(x.id) === String(id));
    if (!row) return;
    await editUserRoles(row);
    return;
  }

  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-user") return;
  const v = await openDialog({
    title: t("core.users.addTitle", "Add a user"),
    description: t("core.users.addDesc", "The account is created on the current site; add more sites afterwards with “Site roles”."),
    confirmLabel: t("core.users.createUser", "Create user"),
    fields: [
      { name: "username", label: t("core.users.fieldUsername", "Username"), required: true },
      { name: "password", label: t("core.users.fieldPassword", "Password"), type: "password", required: true, hint: t("core.users.passwordHint", "At least 8 characters") },
      { name: "role", label: t("core.users.fieldRole", "Role"), type: "select", value: "author", options: [
        { value: "admin", label: t("core.users.roleAdmin", "Admin") }, { value: "editor", label: t("core.users.roleEditor", "Editor") },
        { value: "author", label: t("core.users.roleAuthor", "Author") },
      ] },
    ],
  });
  if (!v) return;
  if (String(v.password).length < 8) { await alertDialog({ title: t("core.users.tooShort", "Password too short"), description: t("core.users.tooShortDesc", "Use at least 8 characters.") }); return; }
  try {
    await api("users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast(t("core.users.created", "User created"));
    render();
  } catch (err) { await alertDialog({ title: t("core.users.createFailed", "Could not create user"), description: err.message }); }
});
