# Multi-user Project Planner

A web-based planning tool for projects where several teams, or several organisations, plan together.

## Why

Large projects rarely have a single plan. A supplier has a contract plan agreed with the customer, an internal plan for its own teams, and reporting plans for management. Subcontractors have plans of their own. Keeping them consistent by hand, by copying dates between spreadsheets and Gantt files, is slow and error-prone.

The planner keeps all these plans in one place and connects them:

- **Shared tasks:** a task is owned by one plan and can be used, live, in others. A task can be followed (MONITOR) or bound by agreement (AGREEMENT), where a change needs the other side's approval.
- **Approvals:** plans move step by step from **Estimated** (the working draft) to **Current** (committed internally) to **Agreed** (agreed with other parties), with approvals from everyone involved.
- **History:** every accepted step leaves a locked baseline, and every change is in the audit log.

## Features

- **Plans:** any number of plans per project, and project hierarchies with subprojects.
- **Gantt charts:** task hierarchy, task IDs, predecessors in notation like `4FS+3d`, dependency checks on working time, baseline overlays and a today line.
- **Baselines:** named, locked snapshots and editable what-if branches.
- **Approvals:** change requests, an approval inbox and a full audit log.
- **Timelines:** user-defined, with rows, callouts and tasks from any project, plus a calendar view.
- **Reports:** HTML, PDF and CSV from saved report definitions.
- **Multi-user:** live updates when others change data, and roles per project and plan.
- **Sign-in:** local accounts, LDAP or OpenID Connect single sign-on.
- **Storage:** files on disk or SQL (PostgreSQL, SQLite, SQL Server).
- **AI assistants:** an MCP server lets them read plans and propose changes. Approvals stay with people.
- **Easy to deploy:** the client is a single HTML file that runs hosted or straight from the file system.

## Documentation

- [Getting started](docs/getting-started.md): run it locally and plan a first project.
- [User guide](docs/user-guide.md): projects, plans, the Gantt, external tasks, approvals, timelines and reports.
- [Server administration](docs/admin-guide.md): installation, configuration, storage, sign-in, users and MCP/ChatGPT.
- [CLAUDE.md](CLAUDE.md): the architecture and the rules of the domain, for developers.

## Quick start

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev
```

Open http://localhost:5173 and create the first administrator. See [Getting started](docs/getting-started.md) for the next steps.

## Built with

Node.js and TypeScript on the server; React, Dockview, DHTMLX Gantt (Community Edition), FullCalendar and dnd-kit in the client; Kysely for SQL.

## License

MIT — see [LICENSE](LICENSE).
