// A saved answer of the official MCP registry (registry.modelcontextprotocol.io,
// GET /v0.1/servers?version=latest, November 2026), trimmed to five servers: two Streamable HTTP
// remotes with headers, an npm and a PyPI package with environment variables, and one marked
// deprecated here (to check it's left out). Used by the tests only (D343).

export const REGISTRY_SAMPLE: unknown = {
  servers: [
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
        name: "ai.smithery/Hint-Services-obsidian-github-mcp",
        description:
          "Connect AI assistants to your GitHub-hosted Obsidian vault to seamlessly access, search, and analy…",
        repository: {
          url: "https://github.com/Hint-Services/obsidian-github-mcp",
          source: "github",
        },
        version: "0.4.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://server.smithery.ai/@Hint-Services/obsidian-github-mcp/mcp",
            headers: [
              {
                description: "Bearer token for Smithery authentication",
                isRequired: true,
                value: "Bearer {smithery_api_key}",
                isSecret: true,
                name: "Authorization",
              },
            ],
          },
        ],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          statusChangedAt: "2025-09-14T15:20:36.371442Z",
          publishedAt: "2025-09-14T15:20:36.371442Z",
          updatedAt: "2025-09-14T15:20:36.371442Z",
          isLatest: true,
        },
      },
    },
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "app.tuper/github-repos",
        description:
          "GitHub repository search past the 1,000 cap, with your own token. Runs on Apify.",
        title: "GitHub Repos (Apify Actor) by Tuper",
        version: "1.0.0",
        websiteUrl: "https://apify.com/tuper/github-repos?src=mcp-registry",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.apify.com?tools=tuper/github-repos",
            headers: [
              {
                description:
                  "Optional. 'Bearer <your Apify API token>'. Leave unset to sign in to Apify with OAuth instead.",
                isSecret: true,
                name: "Authorization",
              },
            ],
          },
        ],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          statusChangedAt: "2026-11-02T20:47:57.719109Z",
          publishedAt: "2026-11-02T20:47:57.719109Z",
          updatedAt: "2026-11-02T20:47:57.719109Z",
          isLatest: true,
        },
      },
    },
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.000safah000-ai/blackhawk-mcp",
        description: "BlackHawkMCP - connect AI to Google Sheets",
        repository: {
          url: "https://github.com/000safah000-ai/BlackHawkMCP",
          source: "github",
        },
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "blackhawk-mcp",
            version: "1.0.0",
            transport: {
              type: "stdio",
            },
            environmentVariables: [
              {
                description: "Google OAuth2 client ID",
                isRequired: true,
                format: "string",
                name: "GOOGLE_CLIENT_ID",
              },
              {
                description: "Google OAuth2 client secret",
                isRequired: true,
                format: "string",
                isSecret: true,
                name: "GOOGLE_CLIENT_SECRET",
              },
              {
                description: "OAuth2 redirect URI",
                format: "string",
                name: "GOOGLE_REDIRECT_URI",
              },
            ],
          },
        ],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          statusChangedAt: "2026-04-24T16:42:10.402876Z",
          publishedAt: "2026-04-24T16:42:10.402876Z",
          updatedAt: "2026-04-24T16:42:10.402876Z",
          isLatest: true,
        },
      },
    },
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.06ketan/medium-ops",
        description: "Medium CLI + 23-tool MCP server. Your IDE drafts replies. No API keys.",
        title: "medium-ops",
        repository: {
          url: "https://github.com/06ketan/medium-ops",
          source: "github",
        },
        version: "0.1.2",
        websiteUrl: "https://medium-ops.chavan.in",
        packages: [
          {
            registryType: "pypi",
            registryBaseUrl: "https://pypi.org",
            identifier: "medium-ops",
            version: "0.1.2",
            runtimeHint: "uvx",
            transport: {
              type: "stdio",
            },
            packageArguments: [
              {
                type: "positional",
                value: "mcp",
              },
              {
                type: "positional",
                value: "serve",
              },
            ],
            environmentVariables: [
              {
                description:
                  "Legacy Medium Integration Token (api.medium.com/v1/*). Optional. Generate at medium.com/me/settings → 'Integration tokens' (note: Medium stopped issuing new tokens in 2023).",
                isSecret: true,
                name: "MEDIUM_INTEGRATION_TOKEN",
              },
              {
                description:
                  "Medium 'sid' cookie value from medium.com (Application → Cookies). Used for authenticated reads + dashboard GraphQL.",
                isSecret: true,
                name: "MEDIUM_SID",
              },
              {
                description:
                  "Medium 'uid' cookie value. Required alongside sid for some authenticated endpoints.",
                name: "MEDIUM_UID",
              },
              {
                description:
                  "Medium 'xsrf' cookie value. Required for any dashboard write (post_response, publish_post, delete_post, draft updates).",
                isSecret: true,
                name: "MEDIUM_XSRF",
              },
              {
                description:
                  "Cloudflare 'cf_clearance' cookie. Only required when Cloudflare challenges your IP for dashboard write calls.",
                isSecret: true,
                name: "MEDIUM_CF_CLEARANCE",
              },
              {
                description:
                  "Your Medium handle (without the @). Required for the public RSS read path so the client knows whose feed to fetch.",
                name: "MEDIUM_USERNAME",
              },
              {
                description:
                  "Override path to the mcp.json file the auth layer reads. Defaults to ~/.cursor/mcp.json.",
                name: "MEDIUM_OPS_MCP_PATH",
              },
              {
                description:
                  "Optional: override the host CLI used by the unattended daemon path (default: auto-detect claude / cursor-agent / codex on PATH). Use {prompt} placeholder if your CLI takes the prompt as an arg.",
                name: "MEDIUM_OPS_LLM_CMD",
              },
            ],
          },
        ],
        _meta: {
          "io.modelcontextprotocol.registry/publisher-provided": {
            tool: "manual",
            version: "0.1.2",
          },
        },
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          statusChangedAt: "2026-05-03T06:02:58.252062Z",
          publishedAt: "2026-05-03T06:02:58.252062Z",
          updatedAt: "2026-05-03T06:02:58.252062Z",
          isLatest: true,
        },
      },
    },
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-09-16/server.schema.json",
        name: "ai.smithery/saidsef-mcp-github-pr-issue-analyser",
        description:
          "A Model Context Protocol (MCP) application for automated GitHub PR analysis and issue management.…",
        repository: {
          url: "https://github.com/saidsef/mcp-github-pr-issue-analyser",
          source: "github",
        },
        version: "1.15.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://server.smithery.ai/@saidsef/mcp-github-pr-issue-analyser/mcp",
            headers: [
              {
                description: "Bearer token for Smithery authentication",
                value: "Bearer {smithery_api_key}",
                name: "Authorization",
              },
            ],
          },
        ],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "deprecated",
          statusChangedAt: "2025-10-05T14:58:08.898007Z",
          publishedAt: "2025-10-05T14:58:08.898007Z",
          updatedAt: "2025-10-05T14:58:08.898007Z",
          isLatest: true,
        },
      },
    },
  ],
  metadata: {
    nextCursor: "io.github.06ketan/medium-ops:0.1.2",
    count: 5,
  },
};
