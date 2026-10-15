# Documentation

Three kinds of document live here. Knowing which one you are reading matters,
because they age differently.

## `docs/` root — the living documents

| Document | What it is |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design of record. Every numbered rule the tests enforce is defined here, with the reasoning. If code and this file disagree, one of them is a bug. |
| [`HANDOVER.md`](HANDOVER.md) | Where the project is right now: commit trail, what is done, what is next, and the pitfalls worth knowing before you touch anything. **Start here when you pick the project up.** |

## `docs/guides/` — task-oriented, for people writing against the system

| Document | Read it when |
|---|---|
| [`THEME-DEV.md`](guides/THEME-DEV.md) | you are writing or debugging a theme |
| [`PLUGIN-DEV.md`](guides/PLUGIN-DEV.md) | you are writing a plugin |
| [`I18N.md`](guides/I18N.md) | you are changing content or UI languages |
| [`MEDIA-STORAGE.md`](guides/MEDIA-STORAGE.md) | you are storing uploads on imgbb / postimages.org instead of R2 |

These are kept current: they describe the system as it is, not as it was planned.

## `docs/design/` — decisions and research

| Document | What it is |
|---|---|
| [`PLUGIN-ARCHITECTURE.md`](design/PLUGIN-ARCHITECTURE.md) | The plugin model decisions (v0.8.0 batch 10) |
| [`PLUGIN-DESIGN-RESEARCH.md`](design/PLUGIN-DESIGN-RESEARCH.md) | The reference-implementation study those decisions came from |
| [`MEDIA-EDITOR-PLAN.md`](design/MEDIA-EDITOR-PLAN.md) | Batch 16: media ownership/isolation, the shared media control, and the block-attribute contract — **shipped** (Tracks 0, B1–B4 part 1, A3–A4; the doc marks what is done and what is left) |
| [`THEME-ARCHITECTURE-PLAN.md`](design/THEME-ARCHITECTURE-PLAN.md) | ⚠️ A **historical plan**, not current state — most of it has shipped, some was superseded |
| [`PERMALINK-SETTINGS-PLUGINS-SHOP-PLAN.md`](design/PERMALINK-SETTINGS-PLUGINS-SHOP-PLAN.md) | Roadmap & requirements for permalink engine, settings expansion, hook-tester plugin, and shop theme admin capabilities |

Design documents record why a choice was made. They are not updated when the code
moves on; `ARCHITECTURE.md` is.

## `docs/history/` — past work, kept for the record

| Document | What it is |
|---|---|
| [`REVIEW-2026-09-29.md`](history/REVIEW-2026-09-29.md) | A code review of the multi-language invariants, plus what was fixed |
| [`HANDOVER-PLUGIN-BATCH.md`](history/HANDOVER-PLUGIN-BATCH.md) | The batch-10 handover, archived once the batch closed |

⚠️ **Do not follow commands in `history/`.** They are transcribed as they were at
the time, and paths or suites may since have been renamed or deleted. The
current instructions live in `AGENTS.md` and `docs/guides/`.

---

The hard rules an AI or human must follow when changing code are in
[`AGENTS.md`](../AGENTS.md) — it is deliberately separate from this tree because
it is *normative*, while everything here is *descriptive*.
