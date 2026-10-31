# CLAUDE.md — Multi-user Project Planning System

This file gives Claude (and developers) context for working in this repository. Read all of it before making changes.

## 1. Purpose

A web-based, multi-user project planning system in which a project can have a **user-defined number of plans** (e.g. contract/external plan, internal plans, internal reporting plans, etc.). Plans contain **tasks**, can be **baselined**  multiple times, support **branching** of historical and future versions, and have an **approval workflow** for moving **tasks** from estimated → current → agreed.

The user interface is an HTML page with Gantt charts, timelines and a calendar views. Data is stored through one of two backends: **files** or an **SQL database**, selected in a configuration file.

## 2. Architecture

```
┌──────────────────────────────┐
│  Client (HTML + JS/TS)       │  Gantt, timelines, calendars, reports
└──────────────┬───────────────┘
               │ REST/JSON (+ WebSocket for live updates)
┌──────────────▼───────────────┐
│  Application server           │  Business logic, approvals, access control
│  └─ StorageAdapter (interface)│
│      ├─ FileAdapter           │  JSON files on disk
│      └─ SqlAdapter            │  PostgreSQL / SQLite / SQL Server
└──────────────────────────────┘
```

- **All business logic lives in the server**, not in the client and not in the adapters. Adapters only store and retrieve.
- **The server is written in Node.js with TypeScript** (strict mode). Shared types in `/shared` are TypeScript and used by both client and server.
- **The client is written in React with TypeScript** (strict mode, function components and hooks). Third-party UI components that manage their own DOM (e.g. the Gantt) are wrapped in a React component that owns the instance and syncs it with React state.
- **Client libraries**:
  - **Dockview** — multi-panel workspace (dockable, resizable, tabbed panels). The panel layout is serialised and stored as a Workspace.
  - **FullCalendar (MIT core only)** — calendar view. Do not use FullCalendar Premium plugins.
  - **dnd-kit** — dragging tasks/milestones from plans into timelines, including between Dockview panels.
  - **DHTMLX Gantt Community Edition** — Gantt view (see §7).
- A browser cannot safely write shared files for multiple users at once; a thin server is therefore used for the file backend as well.
- The client must never know which backend is in use.

### MCP interface

The backend exposes a **Model Context Protocol (MCP) server** alongside the REST API, so AI assistants and agents can read and work with plans.

- Implemented with the official TypeScript SDK (`@modelcontextprotocol/sdk`) in `/server/mcp`, served over Streamable HTTP at `mcp.path` on the same Node server. Enabled/disabled in `config.json`.
- **MCP is a thin layer over `/server/services`**, exactly like the REST API. No business logic, storage access or access-control decisions in `/server/mcp`.
- **Every MCP call runs as an authenticated user** using the configured auth mode (local, SSO, LDAP), with the same roles and permissions as the UI. Calls are written to the AuditLog and marked as coming from MCP.
- **Tools** (initial set): list projects and plans; get plan items, dependencies and links; create/update/move tasks; create and compare baselines; create ChangeRequests; list pending approvals; run a ReportDefinition.
- **Resources**: read-only views of projects, plans, baselines and report definitions, addressed by URI (e.g. `planning://project/{id}/plan/{id}`).
- Tool inputs and outputs are typed with the shared types in `/shared` and validated with schemas (zod).
- Changes made through MCP go through the same acceptance workflow as the UI: an agent can propose and create ChangeRequests, but locked baselines stay immutable.
- **Approvals are UI only.** Approving, rejecting or accepting a ChangeRequest (including moves to Current or Agreed) cannot be done through MCP. Do not add MCP tools for this; the service layer must also reject approval calls that originate from MCP.
- MCP tools are covered by the same tests as the services they call, plus contract tests for tool schemas.

### Client deployment modes

The built client must work in two ways **from the same build output**:

1. **Hosted** — served by the Node server or any web server (`https://…/index.html`).
2. **Opened from the file system** — the user opens `index.html` directly (`file://…/index.html`).

In both modes the client talks to the application server over HTTP; opening from file only removes the need to host the client, not the server.

Rules that make `file://` work:

- **Single-file build**: Vite with `vite-plugin-singlefile` inlines all JS and CSS into `index.html`. Use `base: "./"`. **No code splitting or dynamic `import()`**, no web workers loaded from separate files — browsers block these on `file://`.
- **Assets** (icons, fonts) are inlined or embedded; no runtime fetches of files next to `index.html`.
- **Client configuration** lives in `client-config.js` next to `index.html`, loaded with a classic `<script src="client-config.js">` (works on `file://`, unlike `fetch`). It sets:
  ```js
  window.PLANNING_CLIENT_CONFIG = {
    apiUrl: "https://planning.example.com"   // empty/omitted when hosted by the server = same origin
  };
  ```
  The client reads this once at startup; never hard-code the server URL.
- **Routing**: use hash-based routing (`HashRouter`), since there is no server to rewrite paths on `file://`.
- **Auth in file mode**: cookies are not usable from `file://`, so the client uses bearer tokens (`Authorization` header) in both modes. Tokens are kept in memory; `localStorage` on `file://` is shared by all local files and must not hold tokens.
- **CORS**: the server allows the configured hosted origins. Requests from `file://` arrive with `Origin: null`; allowing them is controlled by `server.allowFileClient` in `config.json` (off by default) and requires bearer-token auth.
- **SSO** uses browser redirects, which cannot return to a `file://` page. In file mode, use local or LDAP login; SSO is supported in hosted mode.
- E2E tests (Playwright) run the main flows in **both** modes.

### Configuration file (`config.json`)

```json
{
  "backend": "file",            // "file" | "sql"
  "file": {
    "path": "./data"
  },
  "sql": {
    "dialect": "postgres",       // "postgres" | "sqlite" | "mssql"
    "connectionString": "postgres://user:pass@host:5432/planning"
  },
  "server": {
    "port": 8080,
    "allowedOrigins": ["https://planning.example.com"],
    "allowFileClient": false     // allow clients opened from file:// (Origin: null)
  },
  "mcp": {
    "enabled": true,
    "path": "/mcp"               // Streamable HTTP endpoint on the same server
  },
  "auth": {
    "mode": "local",             // "local" | "sso" | "ldap"
    "local": {
      "passwordMinLength": 12,
      "sessionTimeoutMinutes": 480
    },
    "sso": {
      "protocol": "oidc",        // "oidc" | "saml"
      "issuer": "https://login.example.com",
      "clientId": "planning",
      "clientSecret": "${SSO_CLIENT_SECRET}",
      "redirectUri": "https://planning.example.com/auth/callback",
      "groupClaim": "groups"     // used for mapping to roles
    },
    "ldap": {
      "url": "ldaps://ldap.example.com:636",
      "bindDn": "cn=svc-planning,ou=services,dc=example,dc=com",
      "bindPassword": "${LDAP_BIND_PASSWORD}",
      "userSearchBase": "ou=users,dc=example,dc=com",
      "userFilter": "(uid={username})",
      "groupSearchBase": "ou=groups,dc=example,dc=com"
    },
    "roleMapping": {             // optional: external group → project role
      "planning-admins": "ADMIN"
    }
  }
}
```

- The server reads `config.json` at startup. The path can be overridden with the environment variable `PLANNING_CONFIG`.
- Secrets (passwords in the connection string, SSO client secret, LDAP bind password) must be loadable from environment variables (`${VAR}` syntax) and never committed.
- Authentication is selected with `auth.mode`; only the section for the selected mode is required. Each mode is implemented as an `AuthProvider` behind a common interface in `/server/auth`, so the rest of the server is independent of the mode.
- For SSO and LDAP, users are created in the system on first login. `roleMapping` can assign roles from external groups; roles can also be managed in the system.

## 3. Folder structure (target)

```
/client          React + TypeScript UI
  /views         gantt/, timeline/, calendar/, reports/
  /components    shared UI components
/server
  /domain        entities and business rules (pure logic, no I/O)
  /services      baseline, approval, linking, reporting
  /api           REST endpoints
  /mcp           MCP server (tools and resources over the same services)
  /auth          AuthProvider interface + local, sso, ldap providers
  /storage
    StorageAdapter.ts
    /file        FileAdapter
    /sql         SqlAdapter + migrations
/shared          types shared between client and server
/tests
config.example.json
```

## 4. Domain model

### Core entities

| Entity | Description |
|---|---|
| **Project** | Top level. Has many plans, users and roles. A project may have subprojects. |
| **Plan** | User-defined type (contract, internal, reporting, …). Belongs to one project. May have an owning/responsible party. |
| **Task** | The single item entity in a plan. Its kind (task, milestone, activity) is derived, not stored — see "Taks kinds" below. |
| **Ownership** | A Task is either **internal** (lives only in one plan) or **external** (owned by one plan, can be used in several). |
| **TaskReference** | Use of an external item in another plan. Points to the owner item; holds no copy of its dates. |
| **PlanLink** | Link between two plans (or between an item and a reference) of type **MONITOR** or **AGREEMENT**. |
| **Dependency** | Dependency between items (FS, SS, FF, SF + lag), also across plans via references. |
| **Baseline** | Snapshot of a plan. Has a type, a parent (for branching) and settings. |
| **BaselineDefinition** | Configuration of a baseline type (see §6). |
| **ChangeRequest** | Proposed change/acceptance that requires approval. |
| **Approval** | One party's approval/rejection of a ChangeRequest. |
| **Timeline** | User-defined timeline that items are dragged into. |
| **Workspace/View** | The user's layout of open panels (plans, timelines, calendars). |
| **ReportDefinition** | Saved report setup that can be run repeatedly. |
| **User / Role / Party** | Users, roles per project/plan, and parties (organisations/teams) that approve. |
| **AuditLog** | Immutable log of all changes and approvals. |

### Task kinds

There is one item entity, the **Task**. Its kind follows from its data:

| Kind | Rule |
|---|---|
| **Milestone** | A task with zero duration. |
| **Activity** | A task with one or more subtasks. Its start, end and duration span its subtasks. |
| **Task** | A task with non-zero duration and no subtasks. |

- The kind is computed (e.g. `getItemKind(task)` in `/server/domain`, shared with the client), never stored as a separate field, so it cannot get out of sync.
- Setting a task's duration to zero makes it a milestone; adding a subtask makes it an activity. A milestone cannot have subtasks.
- Activity dates are rolled up from subtasks and are not edited directly.

### Internal vs. external items

- **Internal**: visible and editable only within its own plan.
- **External**: has one **owner plan** and one or more **recipient plans** via `TaskReference`.
  - Changes are always made in the owner plan.
  - Recipient plans always see the owner's current values (live), but can compare against their own agreed baseline.

### Link types (per PlanLink)

| Type | Behaviour |
|---|---|
| **MONITOR** | Recipient sees changes and receives notifications/variance markers. No approval required. |
| **AGREEMENT** | Changes affecting agreed values require approval from **all** parties to the link before they become *agreed*. Until then the change is shown as *proposed*. |

The link type is set per link, not per plan. The same external item can be MONITOR towards one plan and AGREEMENT towards another.

**Upgrading MONITOR → AGREEMENT** does not require a new approval round. The upgrade takes effect immediately, and the items' current agreed values carry over as the starting point of the agreement. Only changes made *after* the upgrade go through the AGREEMENT approval workflow. The upgrade is recorded in the AuditLog.

## 5. Time granularity

Every task is planned in one unit: **hours, days, weeks, months or years**.

- Always store start/end as a **UTC timestamp** + a `granularity` field + `duration` in the chosen unit.
- Display is rounded/snapped to the granularity.
- Working calendar (holidays, working hours) per project; used when calculating hour/day durations.
- Conversion between units happens in a single helper module (`/shared/time`). Do not duplicate date logic.
- Default display time zone: the user's; storage: UTC.

## 6. Baselines, branching and acceptance

### Baseline types

Every plan has at least these three "tracks":

| Track | Meaning |
|---|---|
| **Estimated** | Working draft / forecast. Freely editable by the plan's owners. |
| **Current** | The current internally committed plan. |
| **Agreed** | Agreed with other parties (contract/agreement). |

In addition, users can create **any number of named baselines** (snapshots) over time.

### Branching

- A baseline has a `parentBaselineId` → forms a tree.
- Historical baselines are **immutable** once locked.
- Future "what-if" branches can be created from any baseline and edited independently.
- A branch can be promoted to Estimated/Current through the acceptance workflow.

### BaselineDefinition (settings)

Configures how a baseline type behaves:

```json
{
  "name": "Agreed",
  "acceptFrom": "Current",            // which track items are accepted from
  "requiresApproval": true,
  "approvers": ["PLAN_OWNER"],        // roles/parties
  "externalItemRule": "OWNER_AND_RECIPIENTS", // external: owner + all recipients must approve
  "granularityOfAcceptance": "ITEM",  // ITEM | BATCH | WHOLE_PLAN
  "lockOnAccept": true,
  "allowBranching": true
}
```

### Acceptance workflow

1. **Estimated → Current**: per item or in batch. Requires approval according to the definition (typically the plan owner).
2. **Current → Agreed**:
   - Internal items: approval from the plan's approvers.
   - **External items: the owner and all recipients must approve** before the item becomes agreed.
   - Items on AGREEMENT links: all parties to the link must approve.
3. Approval is handled through `ChangeRequest` → `Approval[]`. Status: `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `SUPERSEDED`.
4. Acceptance is **atomic**: either the whole ChangeRequest is accepted, or nothing is.
5. A new change to an item with an open ChangeRequest marks the old one as `SUPERSEDED`.
6. **Rejected approval on an external item that is already current in a recipient plan**: the item stays in Current in the recipient plan, but gets the agreement state `REJECTED`. It is not rolled back. The rejected state is shown in the UI and kept until a new ChangeRequest is approved or the item changes.

## 7. User interface

- **Workspace with any number of panels**: users can open any number of plans, timelines and calendars side by side. The layout is saved as a Workspace.
- **Gantt**: hierarchy (WBS), dependency arrows, drag to move/resize, zoom from hours to years.
- **Baseline overlay**: select one or more baselines and show them as shadow/outline bars behind the active plan. Variances are colour-coded (earlier/later). Default: Agreed, Current, Estimated.
- **Timelines**: user-configurable (name, time span, scale, rows/swimlanes). Tasks are **dragged in** from a plan; the timeline shows references, not copies.
- **Calendar view**: day/week/month/year; tasks shown as events, milestones as markers.
- **Status indicators**: internal/external, MONITOR/AGREEMENT, pending approval, rejected, variance against agreed.
- **Approval inbox**: list of ChangeRequests the user needs to act on.
- Live updates via WebSocket when other users change data.

### Gantt library: DHTMLX Gantt Community Edition (MIT)

- Package: `dhtmlx-gantt` v10+ (MIT, shipped as TypeScript/JS source). Do **not** use PRO-only APIs; `dhtmlxgantt.d.ts` also lists PRO methods that do not exist in this edition.
- Framework-agnostic; wrap it in our own component. PRO framework wrappers are not available.
- Features **not** in the Community Edition that this system needs, and which we build ourselves:
  - **Baseline overlay** (multiple baselines per bar) — rendered as our own layer positioned with the Gantt's date-to-pixel API and kept in sync on scroll/zoom.
  - **Working-time calendars** — calculated in `/shared/time` and on the server, not by the Gantt.
  - **Today line / markers**, **undo/redo**, **multi-select and horizontal drag** — implement in our own UI layer if needed.
- Auto-scheduling, critical path and resources are out of scope for the Gantt component; any scheduling logic lives in `/server/services`.
- Keep all DHTMLX-specific code behind an adapter in `/client/views/gantt` so the library can be replaced (or upgraded to PRO) without touching the rest of the client.
- Do not modify the library source in place. If a patch is unavoidable, keep it in `/client/vendor-patches` with a note explaining why.

## 8. Reports

- The user selects content: one or more plans, timelines, calendar views, baselines to overlay, time span, filters and granularity.
- The setup is saved as a **ReportDefinition** and can be rerun at any time (against current data or a specific baseline/date).
- Export formats: PDF and HTML first; Excel/CSV for tabular data.
- Report generation must be deterministic: same definition + same data snapshot = same result.

## 9. Storage

### StorageAdapter (contract)

Both adapters implement the same interface. Write tests against the interface and run them for both.

```ts
interface StorageAdapter {
  // CRUD for all entities
  get<T>(type: EntityType, id: string): Promise<T | null>;
  query<T>(type: EntityType, filter: Filter): Promise<T[]>;
  save<T extends Versioned>(type: EntityType, entity: T): Promise<T>; // optimistic locking
  delete(type: EntityType, id: string, version: number): Promise<void>;
  // Transaction for atomic acceptance
  transaction<R>(fn: (tx: StorageAdapter) => Promise<R>): Promise<R>;
}
```

- All entities have `id` (UUID), `version` (integer), `createdAt/By`, `updatedAt/By`.
- **Optimistic locking**: `save` fails with `ConflictError` if `version` does not match.

### FileAdapter

```
data/
  projects/<projectId>/
    project.json
    plans/<planId>.json
    items/<itemId>.json
    baselines/<baselineId>.json     (locked snapshot, never modified)
    links.json
    changeRequests/<id>.json
    timelines/, reports/, workspaces/
    audit/<yyyy-mm>.jsonl           (append-only)
```

- Write atomically: write to a temp file and rename.
- Project-level file lock for transactions.
- Suitable for small teams / simple installations.

### SqlAdapter

- Migrations versioned in `/server/storage/sql/migrations`. Never modify a migration that has been run.
- Core tables: `project, plan, plan_item, plan_item_reference, plan_link, dependency, baseline, baseline_item, baseline_definition, change_request, approval, timeline, timeline_entry, workspace, report_definition, app_user, party, role_assignment, audit_log`.
- `baseline_item` stores a snapshot of dates/duration per item per baseline.
- Use parameterised queries; no string concatenation of SQL.

## 10. Access control and multi-user

- Roles per project/plan: `ADMIN`, `PLAN_OWNER`, `EDITOR`, `APPROVER`, `VIEWER`.
- Parties represent organisations/teams in approvals; a user can represent a party.
- All access control is enforced in the server.
- All changes and approvals are written to the AuditLog.

## 11. Conventions for Claude

- Business rules (acceptance, approval, link types) belong in `/server/domain` and `/server/services`, with unit tests. No rules in adapters or the UI.
- When changing the data model: update shared types, both adapters, the SQL migration and this file.
- Every new feature that touches storage must be tested against **both** backends.
- Dates/times: use only the helper module in `/shared/time`.
- Locked baselines must never be modifiable — add a test if you touch baseline code.
- All project language is English: UI text, code, identifiers, comments and documentation.
- Do not introduce new dependencies without justifying them in the PR description.

## 12. Tooling and commands

### Tools

| Area | Tool |
|---|---|
| Monorepo | npm workspaces: `client`, `server`, `shared` |
| Client build/dev | Vite (React + TypeScript) + `vite-plugin-singlefile` (one `index.html` that runs hosted or from `file://`); dev server proxies `/api` and WebSocket to the server |
| Server dev | tsx (watch mode) |
| Server build | tsc |
| SQL / migrations | Kysely (PostgreSQL, SQLite, SQL Server) |
| Unit/integration tests | Vitest (client, server, shared) |
| Backend tests | Testcontainers for PostgreSQL and SQL Server; SQLite and FileAdapter in-process |
| End-to-end tests | Playwright |
| Lint/format | ESLint (typescript-eslint, react-hooks) + Prettier |
| Type check | `tsc --noEmit` across all packages (Vite and tsx do not type-check) |

- The `StorageAdapter` contract test suite is parameterised and runs against every backend: file, SQLite, PostgreSQL, SQL Server.
- Testcontainers requires Docker. Backend tests that need Docker can be skipped locally with `SKIP_CONTAINER_TESTS=1`, but always run in CI.

### Commands

```
npm install                 # install all workspaces
npm run dev                 # server (tsx watch) + client (Vite) together
npm run build               # build shared, server and client
npm run typecheck           # tsc --noEmit for all packages
npm run lint                # ESLint
npm run format              # Prettier (write)
npm test                    # Vitest, all packages, all backends
npm run test:e2e            # Playwright
npm run migrate             # run Kysely migrations against the configured SQL database
npm run migrate:make <name> # create a new migration
```

Before considering a change done: `npm run typecheck`, `npm run lint` and `npm test` must pass.

## 13. Open decisions

- None at present. Add new open questions here as they arise.
