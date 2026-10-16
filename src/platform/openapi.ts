/**
 * OpenAPI 3.1 schema specification generator for CFPress API.
 * Provides machine-readable API specifications for AI Agents, Claude, Cursor, and OpenAPI tooling.
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
                    status: { type: "string", enum: ["publish", "draft", "future"] },
                    type: { type: "string", default: "post" },
                    locale: { type: "string" },
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
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "site", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Post object" } },
        },
        put: {
          summary: "Update Post",
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
