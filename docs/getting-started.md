# Getting started

This guide runs the planner on your own machine and walks through a first project. To install it for a team, see [Server administration](admin-guide.md).

## Requirements

- Node.js 22.12 or later
- Git

No database is needed: the development setup stores its data in files.

## Run it locally

```sh
git clone <repository-url>
cd Multi-user-Project-Planner
npm install
npm run dev
```

This starts two processes:

- **The server** on http://localhost:8080. It reads `config.dev.json`: file storage in `./data` and local user accounts.
- **The client** (Vite dev server) on http://localhost:5173. It forwards API and live-update requests to the server.

Open http://localhost:5173.

## Create the first administrator

On the first start there are no users yet. The login page asks you to create the first administrator: enter a username, a display name and a password of at least 12 characters. You are signed in straight away.

Sessions are kept in the server's memory and the client keeps no token on disk. Reloading the page or restarting the server asks you to sign in again.

## Plan a first project

1. **Create a project.** On the Projects page, enter a name (and optionally a project type) and choose **Create project**. To make it a subproject, choose a parent project first.
2. **Open it.** Click the project's name. The project workspace opens with the **Project** panel.
3. **Add a plan.** In the Project panel, enter a plan name and type (for example "Delivery", type "contract") and choose **Add plan**. Click the plan in the structure tree to open its Gantt chart.
4. **Add tasks.** Choose **+ Task** in the Gantt toolbar. Give the task a name, start, duration and unit (hours, days, weeks, months or years). A duration of 0 makes it a milestone.
5. **Link tasks.** In the task dialog's **Predecessors** field, enter the IDs of the tasks it depends on, for example `1` or `1FS+2d`.
6. **Accept the plan.** Choose **Baselines & approvals** in the Gantt toolbar, then **Request whole plan: Estimated → Current**. Approve the request in the **Approvals** panel. The plan's Current track now holds your tasks.

The [User guide](user-guide.md) explains each of these steps, and what else the planner can do, in more detail.

## Run the checks

For developers changing the code:

```sh
npm run typecheck    # tsc --noEmit for all packages
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest; set SKIP_CONTAINER_TESTS=1 without Docker
npm run test:e2e     # Playwright, hosted and file:// modes (first: npx playwright install chromium)
```

The SQL Server and PostgreSQL tests use Testcontainers and need Docker. Without Docker, set `SKIP_CONTAINER_TESTS=1`; file storage and SQLite are still tested.

Before a change is done, `npm run typecheck`, `npm run lint` and `npm test` must pass. [CLAUDE.md](../CLAUDE.md) describes the architecture and the conventions.
