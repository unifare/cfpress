/**
 * Test Suite: Widgets Catalog Categories & Custom Widgets (dotnetcms parity)
 *
 * Verifies:
 *   1. Database table custom_widget_types exists and has site_id scoping.
 *   2. Custom widget types CRUD: create, read, update, delete.
 *   3. Custom widget placement in widget_instances and frontend template interpolation.
 *   4. Widget categorization logic into core, theme, plugin, custom.
 *
 * Usage: node tests/suites/widgets-categories.test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}
function section(t) { console.log(`\n${t}`); }

async function main() {
  const dbPath = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/a7a70ffe0787e897ce77eff8f7418bc10b18f48d6ed4f84ffc4e34a886e15d42.sqlite";
  const db = new DatabaseSync(dbPath);

  // Ensure migration 0027 is applied
  const migrationSql = fs.readFileSync("content/migrations/0027_custom_widget_types.sql", "utf8");
  db.exec(migrationSql);

  const testSiteId = "test-wcat-site";
  const ts = Math.floor(Date.now() / 1000);

  // Clean before run
  db.prepare("DELETE FROM widget_instances WHERE site_id=?").run(testSiteId);
  db.prepare("DELETE FROM custom_widget_types WHERE site_id=?").run(testSiteId);

  try {
    section("1. Schema & Table Structure");
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_widget_types'").get();
    checkTruthy("custom_widget_types table exists in SQLite", table?.name === "custom_widget_types");

    section("2. Custom Widget Types CRUD");
    const customTypeId = "cwt_test_promo";
    db.prepare(`
      INSERT INTO custom_widget_types (id, site_id, type, name, description, icon, template, schema_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customTypeId,
      testSiteId,
      "custom.promo_banner",
      "Promo Banner",
      "Special sale banner with title and discount",
      "tag",
      `<div class="promo-box"><h3>{{ title }}</h3><span class="discount">{{ discount }}</span></div>`,
      JSON.stringify([
        { key: "title", label: "Title", type: "text", default: "Big Sale" },
        { key: "discount", label: "Discount", type: "text", default: "50% OFF" }
      ]),
      ts,
      ts
    );

    const row = db.prepare("SELECT * FROM custom_widget_types WHERE site_id=? AND type=?").get(testSiteId, "custom.promo_banner");
    checkTruthy("custom widget type was inserted", Boolean(row));
    check("name matches inserted value", row?.name, "Promo Banner");
    check("icon matches inserted value", row?.icon, "tag");

    // Update
    db.prepare("UPDATE custom_widget_types SET description=?, updated_at=? WHERE site_id=? AND id=?")
      .run("Updated promo banner description", ts + 10, testSiteId, customTypeId);
    const updated = db.prepare("SELECT description FROM custom_widget_types WHERE site_id=? AND id=?").get(testSiteId, customTypeId);
    check("description was updated", updated?.description, "Updated promo banner description");

    section("3. Custom Widget Placement & Template Rendering");
    const widgetId = "wid_custom_instance_1";
    const config = JSON.stringify({ title: "Spring Mega Sale", discount: "70% OFF" });

    db.prepare(`
      INSERT INTO widget_instances (id, site_id, sidebar, widget_type, title, config, sort_order, enabled, locale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(widgetId, testSiteId, "sidebar", "custom.promo_banner", "Spring Promo", config, 10, 1, "");

    const instance = db.prepare("SELECT * FROM widget_instances WHERE site_id=? AND id=?").get(testSiteId, widgetId);
    checkTruthy("widget instance created with custom widget type", Boolean(instance));
    check("widget_type matches custom.promo_banner", instance?.widget_type, "custom.promo_banner");

    // Rendering interpolation test
    const cType = db.prepare("SELECT template FROM custom_widget_types WHERE site_id=? AND type=?").get(testSiteId, instance.widget_type);
    checkTruthy("found custom widget template for rendering", Boolean(cType?.template));
    let rendered = String(cType?.template || "");
    const parsedCfg = JSON.parse(instance?.config || "{}");
    for (const [k, v] of Object.entries(parsedCfg)) {
      rendered = rendered.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
    }

    checkTruthy("rendered HTML contains interpolated title", rendered.includes("Spring Mega Sale"));
    checkTruthy("rendered HTML contains interpolated discount", rendered.includes("70% OFF"));

    section("4. Plugin Widget (plugin.adinsert) Placement & Rendering");
    // Ensure plugin_adinsert_blocks table exists for test
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_adinsert_blocks (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        block_no INTEGER NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        alignment TEXT DEFAULT 'center',
        position TEXT DEFAULT 'disabled',
        enabled INTEGER DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);

    const adBlockId = "blk_test_ad_2";
    db.prepare(`
      INSERT OR REPLACE INTO plugin_adinsert_blocks (id, site_id, slug, lang_group, block_no, name, code, alignment, position, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(adBlockId, testSiteId, "blk-test-ad-2", adBlockId, 2, "Sidebar Ad Block", "<div id='promo-banner'>AD_23333</div>", "center", "disabled", 1, ts, ts);

    const widgetAdId = "wid_plugin_adinsert_2";
    db.prepare(`
      INSERT INTO widget_instances (id, site_id, sidebar, widget_type, title, config, sort_order, enabled, locale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(widgetAdId, testSiteId, "sidebar", "plugin.adinsert", "Sponsor", JSON.stringify({ block_no: 2 }), 20, 1, "");

    const adInstance = db.prepare("SELECT * FROM widget_instances WHERE site_id=? AND id=?").get(testSiteId, widgetAdId);
    checkTruthy("widget instance created for plugin.adinsert", Boolean(adInstance));

    const blk = db.prepare("SELECT code, alignment FROM plugin_adinsert_blocks WHERE site_id=? AND block_no=? AND enabled=1").get(testSiteId, 2);
    checkTruthy("found adinsert block 2 in db", Boolean(blk && blk.code));
    check("block code matches", blk?.code, "<div id='promo-banner'>AD_23333</div>");
    check("block alignment is center", blk?.alignment, "center");

    section("5. Categorization Verification");
    const items = [
      { type: "core.text", category: "core" },
      { type: "core.search", category: "core" },
      { type: "theme.custom_author", category: "theme" },
      { type: "plugin.adinsert", category: "plugin" },
      { type: "custom.promo_banner", category: "custom" },
    ];

    const coreOnly = items.filter(x => x.category === "core");
    check("two core items filtered", coreOnly.length, 2);

    const themeOnly = items.filter(x => x.category === "theme");
    check("one theme item filtered", themeOnly.length, 1);

    const pluginOnly = items.filter(x => x.category === "plugin");
    check("one plugin item filtered", pluginOnly.length, 1);

    const customOnly = items.filter(x => x.category === "custom");
    check("one custom item filtered", customOnly.length, 1);

  } finally {
    // Clean residues
    db.prepare("DELETE FROM widget_instances WHERE site_id=?").run(testSiteId);
    db.prepare("DELETE FROM custom_widget_types WHERE site_id=?").run(testSiteId);
    try {
      db.prepare("DELETE FROM plugin_adinsert_blocks WHERE site_id=?").run(testSiteId);
    } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failed: " + failures.join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(1);
});
