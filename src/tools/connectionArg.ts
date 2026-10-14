import { z } from "zod";
import { connectionTags, describeConnections, type Config } from "../config.js";

// Shared `connection` input for every data tool. Required when more than one
// connection is configured, optional (defaults to the only one) otherwise.
// Using z.enum means the agent sees the valid tags directly in the schema.
export const connectionInput = (cfg: Config) => {
  const tags = connectionTags(cfg) as [string, ...string[]];
  const base = z
    .enum(tags)
    .describe(
      `Which database connection to use. One of: ${tags.join(", ")}. ` +
        "Pick based on the descriptions in the tool text or call list_connections.",
    );
  return cfg.connections.length === 1 ? base.optional() : base;
};

// Appended to tool descriptions so the agent can choose without a round-trip.
export const connectionsBlurb = (cfg: Config): string =>
  `\n\nConfigured connections (pass the tag as \`connection\`):\n${describeConnections(cfg)}`;

export const sourceOf = (tag: string): string => `mssql:${tag}`;

export const sourceNote = (): string =>
  "\n\nWhen relaying the result to the user, ALWAYS state the source as " +
  '"mssql:<connection tag>" (returned in the `source` field) so they know which database it came from.';
