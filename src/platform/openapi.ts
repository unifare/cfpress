/**
 * OpenAPI 3.1 schema specification generator for CFPress API.
 * Provides complete machine-readable API specifications for AI Agents (Cursor, Claude, Windsurf, GPTs, Dify).
 */
export function generateOpenApiSchema(baseUrl = ""): Record<string, any> {
  return {
    openapi: "3.1.0",
    info: {
      title: "CFPress REST API",
      version: "0.8.0",
      description: "Complete REST API for CFPress Headless CMS. Authenticate with Bearer token (`Authorization: Bearer cfp_live_...`) or session cookies.",
    },
    servers: [
      {
        url: `${baseUrl}/api/v1`,
        description: "CFPress API Gateway",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Machine-to-Machine API Key (e.g. cfp_live_xxxx)",
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      "/auth/me": {
        get: {
          summary: "Current User & Identity",
          description: "Get authenticated identity, permissions, and accessible sites.",
          responses: {
            "200": { description: "Identity profile" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/stats": {
        get: {
          summary: "Site Overview & Statistics",
          description: "Get overall site metrics (post count, pages, media, draft counts, and recent changes).",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" }, description: "Site ID (defaults to 'default')" },
          ],
          responses: {
            "200": { description: "Statistics object" },
          },
        },
      },
      "/posts": {
        get: {
          summary: "List Posts",
          description: "List posts with pagination, type, and locale filtering.",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" }, description: "Site ID (defaults to 'default')" },
            { name: "type", in: "query", schema: { type: "string", default: "post" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["publish", "draft", "future", "trash"] } },
            { name: "locale", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          responses: {
            "200": { description: "Posts list with pagination metadata" },
          },
        },
        post: {
          summary: "Create or Publish Post",
          description: "Create a new post or draft. Optionally bind category/tag terms.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    slug: { type: "string" },
                    content: { type: "string" },
                    excerpt: { type: "string" },
                    status: { type: "string", enum: ["publish", "draft", "future"], default: "draft" },
                    type: { type: "string", default: "post" },
                    locale: { type: "string" },
                    terms: { type: "array", items: { type: "string" }, description: "List of term IDs or slugs" },
                    tags: { type: "array", items: { type: "string" }, description: "List of tag names or IDs (auto-creates if non-existent)" },
                    meta: { type: "object", description: "Custom fields key-value pairs" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Post created successfully" } },
        },
      },
      "/posts/{id}": {
        get: {
          summary: "Get Post by ID",
          description: "Retrieve a single post along with all translations and associated terms.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Post details" } },
        },
        put: {
          summary: "Update Post",
          description: "Update an existing post or draft by ID.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    slug: { type: "string" },
                    content: { type: "string" },
                    excerpt: { type: "string" },
                    status: { type: "string" },
                    terms: { type: "array", items: { type: "string" } },
                    meta: { type: "object" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Post updated" } },
        },
        delete: {
          summary: "Delete Post",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Post deleted" } },
        },
      },
      "/pages": {
        get: {
          summary: "List Pages",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          responses: { "200": { description: "Pages list" } },
        },
        post: {
          summary: "Create Page",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    slug: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string", default: "draft" },
                    locale: { type: "string" },
                    template: {
                      type: "string",
                      default: "none",
                      description: "Template to render the page with. Defaults to 'none' (or empty string), which outputs raw page HTML with no theme preset wrappers/styles/layout. Set to 'default' or a theme template name (e.g. 'page', 'about') to use theme templates.",
                    },
                    categories: { type: "array", items: { type: "string" }, description: "List of category IDs, slugs, or names" },
                    tags: { type: "array", items: { type: "string" }, description: "List of tag names" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Page created" } },
        },
      },
      "/pages/{id}": {
        get: {
          summary: "Get Page by ID",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Page details" } },
        },
        put: {
          summary: "Update Page",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    slug: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" },
                    template: {
                      type: "string",
                      description: "Template to render the page with. 'none' or '' for raw HTML without theme presets, or a theme template name (e.g. 'default', 'page', 'about').",
                    },
                    categories: { type: "array", items: { type: "string" } },
                    tags: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Page updated" } },
        },
        delete: {
          summary: "Delete Page",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Page deleted" } },
        },
      },
      "/theme/templates": {
        get: {
          summary: "List Theme Templates",
          description: "List available template names from the active theme for this site (can be assigned to pages or custom post types).",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Templates list" } },
        },
      },
      "/taxonomies": {
        get: {
          summary: "List Taxonomies",
          description: "Get all active taxonomies declared for this site (e.g., category, post_tag).",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Taxonomies list" } },
        },
      },
      "/taxonomies/{taxonomy}/terms": {
        get: {
          summary: "List Terms by Taxonomy",
          description: "Get all terms under a specific taxonomy (categories or tags), supporting multi-language filtering.",
          parameters: [
            { name: "taxonomy", in: "path", required: true, schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" }, description: "Filter by language or universal (omit for all)" },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Terms list" } },
        },
        post: {
          summary: "Create Term",
          description: "Create a new category or tag term with multi-language and translation group support.",
          parameters: [
            { name: "taxonomy", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    slug: { type: "string" },
                    locale: { type: "string", description: "Language code or empty for universal" },
                    lang_group: { type: "string", description: "Translation group ID to tie with siblings" },
                    description: { type: "string" },
                    parent_id: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Term created" } },
        },
      },
      "/taxonomies/{taxonomy}/terms/{id}": {
        get: {
          summary: "Get Term Details",
          parameters: [
            { name: "taxonomy", in: "path", required: true, schema: { type: "string" } },
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Term object" } },
        },
        put: {
          summary: "Update Term",
          parameters: [
            { name: "taxonomy", in: "path", required: true, schema: { type: "string" } },
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    slug: { type: "string" },
                    description: { type: "string" },
                    parent_id: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Term updated" } },
        },
        delete: {
          summary: "Delete Term",
          parameters: [
            { name: "taxonomy", in: "path", required: true, schema: { type: "string" } },
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Term deleted" } },
        },
      },
      "/media": {
        get: {
          summary: "List Media Assets",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 30 } },
          ],
          responses: { "200": { description: "Media files list" } },
        },
        post: {
          summary: "Upload Media File",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    alt_text: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Media created" } },
        },
      },
      "/media/{id}": {
        get: {
          summary: "Get Media File Info",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Media item details" } },
        },
        patch: {
          summary: "Update Media Metadata",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    alt_text: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Media updated" } },
        },
        delete: {
          summary: "Delete Media Asset",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Media deleted" } },
        },
      },
      "/settings": {
        get: {
          summary: "Get Site Settings",
          description: "Read general, SEO, and layout settings for the specified site.",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Settings dictionary" } },
        },
        post: {
          summary: "Save Site Settings",
          description: "Batch update site options such as title, tagline, SEO meta, or posts per page.",
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Key-value map of settings to update (e.g. {'site.title': 'My Blog', 'seo.description': '...'})",
                },
              },
            },
          },
          responses: { "200": { description: "Settings updated" } },
        },
      },
      "/sites": {
        get: {
          summary: "List Sites",
          description: "List all tenant sites configured in CFPress.",
          responses: { "200": { description: "Sites list" } },
        },
      },
      "/sites/{id}": {
        get: {
          summary: "Get Site Details",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Site information and active theme" } },
        },
      },
      "/sites/{id}/locales": {
        get: {
          summary: "Get Site Locales",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Default and enabled locale codes" } },
        },
      },
      "/tables/{logical}": {
        get: {
          summary: "Query Theme Custom Table",
          description: "List rows from a theme-declared custom data table (e.g. books, music, links).",
          parameters: [
            { name: "logical", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "Table rows list" } },
        },
        post: {
          summary: "Insert Row into Theme Custom Table",
          parameters: [
            { name: "logical", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", description: "Row fields matching table schema" },
              },
            },
          },
          responses: { "201": { description: "Row inserted" } },
        },
      },
      "/tables/{logical}/{slug}": {
        get: {
          summary: "Get Custom Table Row by Slug",
          parameters: [
            { name: "logical", in: "path", required: true, schema: { type: "string" } },
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Row data" } },
        },
        put: {
          summary: "Update Custom Table Row",
          parameters: [
            { name: "logical", in: "path", required: true, schema: { type: "string" } },
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "locale", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Row updated" } },
        },
        delete: {
          summary: "Delete Custom Table Row",
          parameters: [
            { name: "logical", in: "path", required: true, schema: { type: "string" } },
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Row deleted" } },
        },
      },
      "/extensions/themes": {
        get: {
          summary: "List Installed Themes",
          parameters: [{ name: "site", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "Themes list and active indicator" } },
        },
      },
      "/extensions/themes/{name}/activate": {
        post: {
          summary: "Activate Theme",
          parameters: [
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Theme activated and capabilities applied" } },
        },
      },
      "/extensions/themes/{name}/files": {
        get: {
          summary: "List Theme Files",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Theme files and templates tree" } },
        },
      },
      "/extensions/themes/{name}/file": {
        get: {
          summary: "Read Theme File",
          parameters: [
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "path", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "File content" } },
        },
        put: {
          summary: "Update or Create Theme File",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path", "content"],
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "File updated" } },
        },
      },
      "/extensions/plugins": {
        get: {
          summary: "List Installed Plugins",
          responses: { "200": { description: "Plugins list and enabled status" } },
        },
      },
      "/extensions/plugins/{name}/toggle": {
        post: {
          summary: "Toggle Plugin Status",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Plugin toggled" } },
        },
      },
      "/auth/api-keys": {
        get: {
          summary: "List API Keys",
          responses: { "200": { description: "List of active API keys" } },
        },
        post: {
          summary: "Create API Key",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    scopes: { type: "array", items: { type: "string" }, default: ["*"] },
                    sites: { type: "array", items: { type: "string" }, default: ["*"] },
                    expires_in_days: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "API Key created with cleartext token" } },
        },
      },
    },
  };
}
