/**
 * The block vocabulary — and the **only** definition of what a block's
 * attributes are.
 *
 * ## Why this file grew a contract
 *
 * A block's `attrs` used to be implicit: the renderer's `switch` read whichever
 * property each case happened to need (`a.url`, `a.items`, `a.html` …), and the
 * editor wrote `attrs.text` for **every** block type. Nothing declared the
 * agreement, so there was none — six of the twelve block types the editor
 * offered rendered as **empty output at HTTP 200**: `core/image`,
 * `core/gallery`, `core/html`, `core/group`, `core/columns` and the link half of
 * `core/button`. That is the "declared before it exists" family again, and it
 * was invisible because the renderer is a one-line `switch` and the editor is a
 * single `<textarea>`.
 *
 * So the attribute set is declared here, once, and three things are derived
 * from it or checked against it:
 *
 *   - `GET /api/v1/blocks` ships it, so the editor renders one control per
 *     declared attribute instead of one textarea per block;
 *   - `architecture.test.mjs` parses `renderBlocks` and requires the attributes
 *     it reads to be **exactly** the ones declared here (a typo on either side
 *     is a red light, not an empty `<div>`);
 *   - `tests/suites/editor-blocks.test.mjs` runs the real renderer over blocks
 *     built from this contract and asserts each produces markup.
 *
 * ## What is deliberately NOT here
 *
 * The HTML. `renderBlocks` lives in `platform/frontend.ts` and keeps its
 * existing markup and class names (`.gallery`, `.wp-button`, `.wp-columns`) —
 * shipped themes style those, so this contract describes **data**, never
 * presentation.
 */

export type Block = { id?: string; type: string; attrs?: Record<string, unknown>; content?: Block[] };

/**
 * How an attribute is edited. A closed set: the editor's control renderer must
 * have a branch per member, and `architecture.test.mjs` compares the two lists
 * (the same "closed set, two tables" guard the settings form uses).
 *
 * `media` and `media-list` are separate from `url` on purpose. They are edited
 * with a media control rather than a text field, and keeping the distinction in
 * the contract is what lets that control arrive later without touching this
 * file — see `docs/design/MEDIA-EDITOR-PLAN.md` (Track A3).
 */
export type BlockAttrType = "text" | "textarea" | "url" | "media" | "media-list";

export interface BlockAttrSpec {
  /** The key inside `block.attrs`. */
  key: string;
  type: BlockAttrType;
  /**
   * Dictionary key for the field's label, resolved server-side like every
   * other admin string (`api.ts` falls back to `fallback` when the UI locale
   * has no entry). Labels are per attribute, not per type: `text` is "Heading
   * text" on a heading and "Alt text" on an image, and flattening them to one
   * word per type would make the editor read like a database form.
   */
  labelKey: string;
  /** English source string, used when the dictionary has no entry. */
  fallback: string;
  /**
   * The renderer produces nothing without it. Declared rather than inferred so
   * the round-trip test can assert the "missing required attr ⇒ empty output"
   * behaviour instead of rediscovering it.
   */
  required?: boolean;
  /**
   * For a `media-list` attribute: the keys of one entry, in order.
   *
   * Declared **here**, on the attribute, rather than attached later by the API:
   * the item shape is part of what the attribute *is*, and a control that has
   * to be told the item keys by its caller renders an empty field when nobody
   * tells it. `architecture.test.mjs` requires every `media-list` attribute to
   * declare them.
   */
  itemKeys?: readonly string[];
}

export interface BlockSpec {
  name: string;
  title: string;
  category: string;
  /** Editable attributes, in the order the editor should show them. */
  attrs: readonly BlockAttrSpec[];
  /**
   * The block nests child blocks in `block.content` instead of holding
   * attribute values. Declared so the editor knows to render a container and
   * the contract guard knows not to expect `attrs` reads for it.
   */
  children?: boolean;
}

/**
 * The keys of one entry in a `media-list` attribute.
 *
 * A gallery item is not a scalar, so the item shape has to be declared
 * somewhere; declaring it here means the editor's repeatable row and the
 * renderer's `x.url` / `x.alt` reads have a shared reference rather than a
 * coincidence.
 */
export const MEDIA_ITEM_KEYS = ["url", "alt"] as const;

/** The closed set of attribute types, as data (the guard compares against it). */
export const BLOCK_ATTR_TYPES: readonly BlockAttrType[] = ["text", "textarea", "url", "media", "media-list"];

export const CORE_BLOCKS: readonly BlockSpec[] = [
  {
    name: "core/paragraph", title: "Paragraph", category: "text",
    attrs: [{ key: "text", type: "textarea", labelKey: "core.block.field.text", fallback: "Text", required: true }],
  },
  {
    name: "core/heading", title: "Heading", category: "text",
    attrs: [{ key: "text", type: "text", labelKey: "core.block.field.heading", fallback: "Heading text", required: true }],
  },
  {
    name: "core/list", title: "List", category: "text",
    attrs: [{ key: "text", type: "textarea", labelKey: "core.block.field.list", fallback: "One item per line", required: true }],
  },
  {
    name: "core/quote", title: "Quote", category: "text",
    attrs: [{ key: "text", type: "textarea", labelKey: "core.block.field.quote", fallback: "Quote", required: true }],
  },
  {
    name: "core/code", title: "Code", category: "text",
    attrs: [{ key: "text", type: "textarea", labelKey: "core.block.field.code", fallback: "Code", required: true }],
  },
  {
    name: "core/image", title: "Image", category: "media",
    attrs: [
      { key: "url", type: "media", labelKey: "core.block.field.imageUrl", fallback: "Image", required: true },
      { key: "alt", type: "text", labelKey: "core.block.field.imageAlt", fallback: "Alt text" },
    ],
  },
  {
    name: "core/gallery", title: "Gallery", category: "media",
    attrs: [{ key: "items", type: "media-list", labelKey: "core.block.field.gallery", fallback: "Images", required: true, itemKeys: MEDIA_ITEM_KEYS }],
  },
  {
    name: "core/button", title: "Button", category: "design",
    attrs: [
      { key: "text", type: "text", labelKey: "core.block.field.buttonLabel", fallback: "Label" },
      { key: "url", type: "url", labelKey: "core.block.field.buttonUrl", fallback: "Link" },
    ],
  },
  { name: "core/separator", title: "Separator", category: "design", attrs: [] },
  {
    name: "core/html", title: "HTML", category: "advanced",
    attrs: [{ key: "html", type: "textarea", labelKey: "core.block.field.html", fallback: "HTML", required: true }],
  },
  { name: "core/group", title: "Group", category: "layout", attrs: [], children: true },
  { name: "core/columns", title: "Columns", category: "layout", attrs: [], children: true },
];

/** Look up a block's contract. `null` for a type the platform does not render. */
export function blockSpec(name: string): BlockSpec | null {
  return CORE_BLOCKS.find((b) => b.name === name) ?? null;
}

/**
 * The attributes a block of this type is allowed to carry.
 *
 * Used by the editor to build its controls and by the round-trip test to build
 * a fully-populated block. Unknown types get an empty list rather than a guess:
 * an unrecognised block already renders as `""`, and inventing attributes for
 * it would only move the silence.
 */
export function blockAttrKeys(name: string): readonly string[] {
  return blockSpec(name)?.attrs.map((a) => a.key) ?? [];
}

export function parseBlocks(content:string):Block[]{try{const value=JSON.parse(content);return Array.isArray(value)?value:[]}catch{return content?[{type:"core/paragraph",attrs:{text:content}}]:[]}}
