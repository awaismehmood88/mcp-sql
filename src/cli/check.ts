#!/usr/bin/env node
// Connectivity test. `npm run test:db` checks every configured connection in
// order; `npm run test:db -- <tag>` checks just one.
import { getConnection, type Config, type ConnectionConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { closePool, runQuery } from "../db.js";

const checkOne = async (cfg: Config, conn: ConnectionConfig): Promise<boolean> => {
  process.stderr.write(
    `[${conn.tag}] Connecting to ${conn.mssql.server}:${conn.mssql.port} ` +
      `db=${conn.mssql.database} user=${conn.mssql.user} ` +
      `encrypt=${conn.mssql.encrypt} trustServerCert=${conn.mssql.trustServerCertificate}` +
      `${conn.ssh ? ` via ssh ${conn.ssh.username}@${conn.ssh.host}` : ""}\n`,
  );

  try {
    const start = Date.now();
    const result = await runQuery(
      cfg,
      conn.tag,
      "SELECT @@VERSION AS version, DB_NAME() AS [database], SUSER_SNAME() AS [login], GETDATE() AS [now]",
    );
    const ms = Date.now() - start;
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      process.stderr.write(`[${conn.tag}] Query returned no rows — unexpected.\n`);
      return false;
    }
    process.stdout.write(`[${conn.tag}] OK (${ms} ms)\n`);
    process.stdout.write(`  database : ${String(row["database"])}\n`);
    process.stdout.write(`  login    : ${String(row["login"])}\n`);
    process.stdout.write(`  now      : ${String(row["now"])}\n`);
    process.stdout.write(`  version  : ${String(row["version"]).split("\n")[0]}\n`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${conn.tag}] FAILED: ${message}\n`);
    printHint(conn, message);
    return false;
  }
};

const printHint = (conn: ConnectionConfig, message: string): void => {
  const { server, port } = conn.mssql;
  if (/no route to host|Channel open failure/i.test(message) && conn.ssh) {
    process.stderr.write(
      `Hint: SSH connected, but the BASTION cannot reach ${server}:${port}.\n` +
        `      Test from the bastion:\n` +
        `        ssh ${conn.ssh.username}@${conn.ssh.host} \\\n` +
        `          "timeout 3 bash -c '</dev/tcp/${server}/${port}' && echo OPEN || echo BLOCKED"\n` +
        `      If BLOCKED, the bastion isn't on a network with route+ACL to the DB.\n`,
    );
  } else if (/encrypt/i.test(message)) {
    process.stderr.write(
      `Hint: set MSSQL_[<TAG>_]TRUST_SERVER_CERT=true (self-signed dev certs) or MSSQL_[<TAG>_]ENCRYPT=false.\n`,
    );
  } else if (/login failed/i.test(message)) {
    process.stderr.write(
      `Hint: check the USER / PASSWORD for this connection, and that the login is mapped to database ${conn.mssql.database}.\n`,
    );
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    process.stderr.write(`Hint: check SERVER host ${server}, PORT ${port}, and that the DB is reachable from here.\n`);
  }
};

const main = async () => {
  const cfg = loadConfig();
  const wanted = process.argv[2];
  const targets = wanted ? [getConnection(cfg, wanted)] : cfg.connections;

  let failures = 0;
  for (const conn of targets) {
    if (!(await checkOne(cfg, conn))) failures++;
    process.stdout.write("\n");
  }
  await closePool();
  if (failures > 0) {
    process.stderr.write(`${failures} of ${targets.length} connection(s) FAILED.\n`);
    process.exit(1);
  }
  process.stdout.write(`All ${targets.length} connection(s) OK.\n`);
};

main().catch((err) => {
  process.stderr.write(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
