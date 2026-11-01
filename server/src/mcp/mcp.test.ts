/** MCP contract tests: tool schemas, origin marking and the "approvals are UI only" rule. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { serviceBackends } from "../testing/backends.js";
import { type Fixture, MONDAY, createFixture } from "../testing/fixture.js";
import { MCP_TOOL_NAMES, createMcpServer } from "./createMcpServer.js";

describe.each(serviceBackends)("MCP server on $name", (backend) => {
  let storage: StorageAdapter;
  let cleanup: () => Promise<void>;
  let f: Fixture;
  let client: Client;

  beforeEach(async () => {
    ({ storage, cleanup } = await backend.create());
    f = await createFixture(storage);
    const server = createMcpServer(f.services, { user: f.alice.user, origin: "MCP" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await cleanup();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: result.isError === true, text, json: () => JSON.parse(text) as unknown };
  };

  it("exposes exactly the documented tools and no approval tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.name).not.toMatch(/^(approve|reject|accept|decide)/);
      expect(t.description).toBeTruthy();
    }
  });

  it("publishes input schemas with required fields", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("create_task")?.inputSchema.required).toEqual(
      expect.arrayContaining(["planId", "name", "start", "duration", "granularity"]),
    );
    expect(byName.get("update_task")?.inputSchema.required).toEqual(
      expect.arrayContaining(["itemId", "version"]),
    );
    expect(byName.get("create_change_request")?.inputSchema.required).toEqual(
      expect.arrayContaining(["planId", "targetTrack", "title"]),
    );
    expect(byName.get("get_plan_items")?.inputSchema.required).toEqual(["planId"]);
  });

  it("creates tasks and change requests as the user, marked as MCP in the audit log", async () => {
    const created = await call("create_task", {
      planId: f.planA.id,
      name: "From agent",
      start: MONDAY,
      duration: 2,
      granularity: "days",
    });
    expect(created.isError).toBe(false);
    const task = created.json() as { id: string };
    const view = (await call("get_plan_items", { planId: f.planA.id })).json() as {
      items: { id: string }[];
    };
    expect(view.items.map((i) => i.id)).toContain(task.id);

    const cr = await call("create_change_request", {
      planId: f.planA.id,
      targetTrack: "CURRENT",
      itemIds: [task.id],
      title: "Agent proposal",
    });
    expect(cr.isError).toBe(false);
    const audit = await f.services.audit.list(f.alice, f.project.id, task.id);
    expect(audit[0]?.origin).toBe("MCP");
    expect(audit[0]?.createdBy).toBe(f.alice.user.id);

    const pending = (await call("list_pending_approvals", {})).json() as unknown[];
    expect(pending).toHaveLength(1);
  });

  it("returns tool errors for validation and permission failures", async () => {
    const invalid = await call("create_task", {
      planId: f.planA.id,
      name: "",
      start: "nope",
      duration: -1,
      granularity: "days",
    });
    expect(invalid.isError).toBe(true);
    const forbidden = await call("create_task", {
      planId: f.planB.id,
      name: "x",
      start: MONDAY,
      duration: 1,
      granularity: "days",
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.text).toContain("FORBIDDEN");
  });

  it("reads resources by URI", async () => {
    const result = await client.readResource({
      uri: `planning://project/${f.project.id}/plan/${f.planA.id}`,
    });
    const body = JSON.parse((result.contents[0] as { text: string }).text) as {
      plan: { id: string };
    };
    expect(body.plan.id).toBe(f.planA.id);
  });
});
