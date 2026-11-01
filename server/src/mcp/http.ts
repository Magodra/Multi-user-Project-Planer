import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Services } from "../services/Services.js";
import type { ServiceContext } from "../services/support.js";
import { createMcpServer } from "./createMcpServer.js";

/**
 * Stateless Streamable HTTP: a fresh server+transport per request, bound to
 * the authenticated user. Calls are marked with origin "MCP" for the AuditLog.
 */
export function mcpHandler(services: Services) {
  return async (req: Request, res: Response): Promise<void> => {
    const ctx: ServiceContext = { user: req.ctx!.user, origin: "MCP" };
    const server = createMcpServer(services, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
