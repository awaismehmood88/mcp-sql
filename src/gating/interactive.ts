import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "../logger.js";

export interface ElicitDecision {
  approved: boolean;
  reason?: string;
}

const MAX_SQL_PREVIEW = 4096;

export const elicitApproval = async (
  server: McpServer,
  sql: string,
): Promise<ElicitDecision> => {
  const preview =
    sql.length > MAX_SQL_PREVIEW
      ? `${sql.slice(0, MAX_SQL_PREVIEW)}\n... [truncated ${sql.length - MAX_SQL_PREVIEW} chars]`
      : sql;

  try {
    const response = await server.server.elicitInput({
      message: `The agent wants to run this SQL against MSSQL. Approve?\n\n${preview}`,
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            title: "Approve query",
            description: "Tick to allow this SQL to execute against the database.",
          },
          reason: {
            type: "string",
            title: "Reason (optional)",
            description: "Optional note attached to the decision.",
          },
        },
        required: ["approve"],
      },
    });

    if (response.action !== "accept") {
      return { approved: false, reason: `User ${response.action}ed the prompt.` };
    }
    const content = response.content as { approve?: unknown; reason?: unknown } | undefined;
    const approve = content?.approve === true;
    const reason = typeof content?.reason === "string" ? content.reason : undefined;
    return { approved: approve, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("elicitation failed", { message });
    throw new Error(
      `Interactive HITL failed: ${message}. The MCP client may not support elicitation; ` +
        `consider switching to MCP_HITL_MODE=dual_stage.`,
    );
  }
};
