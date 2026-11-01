# Multi-user Project Planner

A multi-user project planning tool for coordinating plans between teams. A project has any number of plans (contract, internal, reporting, …) with tasks, milestones and activities. Plans can be baselined, branched and accepted step by step from **Estimated → Current → Agreed**, with approvals from every party involved.

- Gantt charts (DHTMLX Gantt Community Edition) with dependency arrows and baseline overlays
- User-defined timelines (drag tasks in from plans) and a calendar view
- Internal and external tasks: external tasks are owned by one plan and used live in others, through MONITOR or AGREEMENT links
- Approval workflow with ChangeRequests, an approval inbox and an audit log
- Reports (HTML, PDF, CSV) from saved report definitions
- File or SQL storage (PostgreSQL, SQLite, SQL Server), selected in `config.json`
- MCP server so AI assistants can read plans and propose changes (approvals stay with people in the UI)
- Local, LDAP or OIDC single sign-on

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules of the domain.

## Getting started

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev
```

This starts the server on http://localhost:8080 (file storage in `./data`, configured by `config.dev.json`) and the Vite dev client on http://localhost:5173. On first start, the login page asks you to create the first administrator.

## Running in production

```sh
cp config.example.json config.json   # then edit; secrets go in environment variables: "${DB_PASSWORD}"
npm run build
npm start -w @planning/server        # or: PLANNING_CONFIG=/path/to/config.json node server/dist/index.js
```

The client is built into a single file, `client/dist/index.html`, plus `client-config.js`. The same build works in two ways:

- **Hosted**: the server serves it when `server.clientDir` is set (or put it on any web server).
- **From the file system**: open `index.html` directly. Set `apiUrl` in `client-config.js` to the server URL and enable `server.allowFileClient` in `config.json`. Single sign-on needs the hosted mode.

For SQL storage, set `"backend": "sql"`. Migrations run automatically at startup, or with `npm run migrate`.

## MCP

With `mcp.enabled`, the server exposes a Streamable HTTP MCP endpoint at `/mcp`. Authenticate with OAuth 2.1 (see below) or a bearer token from `POST /api/auth/login`. Tools: list projects and plans, read plan tasks, create/update/move/reorder tasks, set predecessors, propose changes to external tasks, create and compare baselines, create change requests, list pending approvals and run reports. Calls run as the user and are marked as MCP in the audit log. Approving or rejecting is only possible in the UI.

### Connecting ChatGPT

OpenAI connects to the MCP endpoint from its own servers, so the planning server must be reachable from the internet over **HTTPS** (for example behind a reverse proxy with TLS). `localhost` does not work.

**1. Create a user for the assistant.** Give it only the project and plan roles it needs: the assistant can do whatever this user can. In local or LDAP mode, sign in to get a bearer token (SSO mode has no password login):

```sh
curl -s -X POST https://planning.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "assistant", "password": "…"}'
# → {"token": "…", "expiresAt": "…", "user": {…}}
```

The token expires after `auth.local.sessionTimeoutMinutes`, and also when the server restarts (sessions are kept in memory). Sign in again to get a new one.

**2a. Through the OpenAI API (works today).** The Responses API can call a remote MCP server and send the token in the `mcp` tool's `headers`:

```sh
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<a model with MCP tool support>",
    "input": "Which tasks in the Delivery plan end after the agreed date?",
    "tools": [{
      "type": "mcp",
      "server_label": "planning",
      "server_url": "https://planning.example.com/mcp",
      "headers": { "Authorization": "Bearer <token from step 1>" },
      "require_approval": "always"
    }]
  }'
```

Keep `require_approval` at `"always"` (the default) if you want to confirm each call before it is made. Tools that change data still go through the normal workflow: an assistant can create change requests and propose changes, but people approve them in the UI.

**2b. In the ChatGPT app (OAuth).** ChatGPT connects custom MCP servers as connectors in developer mode. They sign in with OAuth, which this server provides when `mcp.oauth` is enabled. Availability depends on your ChatGPT plan, and the menu names change between releases; see OpenAI's [developer mode help article](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

1. Enable OAuth in `config.json` and restart the server. Behind a reverse proxy, also set `"server": { "trustProxy": true }`:

   ```jsonc
   "mcp": {
     "enabled": true,
     "path": "/mcp",
     "oauth": { "enabled": true, "issuerUrl": "https://planning.example.com" }
   }
   ```

2. In ChatGPT, turn on developer mode and create a connector with the MCP server URL `https://planning.example.com/mcp`. Choose **OAuth** as the authentication. ChatGPT discovers the rest and registers itself, so there are no client IDs or secrets to copy.
3. When ChatGPT asks you to connect, a planner page opens. Sign in with your planner account (password, or single sign-on in SSO mode) and allow access. ChatGPT then acts as you, with your roles.

Access tokens last `accessTokenMinutes` and are renewed with refresh tokens, valid for `refreshTokenDays`. Tokens are kept in memory: after a server restart, connect the connector again. Approvals still happen only in the planner UI.

## Development

```sh
npm run typecheck    # tsc --noEmit for all packages
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest; set SKIP_CONTAINER_TESTS=1 without Docker
npm run test:e2e     # Playwright, hosted and file:// modes (first: npx playwright install chromium)
```

## License

MIT — see [LICENSE](LICENSE).
