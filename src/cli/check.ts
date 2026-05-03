#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { closePool, runQuery } from "../db.js";

const main = async () => {
  const cfg = loadConfig();
  process.stderr.write(
    `Connecting to ${cfg.mssql.server}:${cfg.mssql.port} ` +
      `db=${cfg.mssql.database} user=${cfg.mssql.user} ` +
      `encrypt=${cfg.mssql.encrypt} trustServerCert=${cfg.mssql.trustServerCertificate}\n`,
  );

  const start = Date.now();
  const result = await runQuery(
    cfg,
    "SELECT @@VERSION AS version, DB_NAME() AS [database], SUSER_SNAME() AS [login], GETDATE() AS [now]",
  );
  const ms = Date.now() - start;

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    process.stderr.write("Query returned no rows — unexpected.\n");
    process.exit(1);
  }

  process.stdout.write(`OK (${ms} ms)\n`);
  process.stdout.write(`  database : ${String(row["database"])}\n`);
  process.stdout.write(`  login    : ${String(row["login"])}\n`);
  process.stdout.write(`  now      : ${String(row["now"])}\n`);
  process.stdout.write(`  version  : ${String(row["version"]).split("\n")[0]}\n`);

  await closePool();
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nFAILED: ${message}\n`);
  if (/encrypt/i.test(message)) {
    process.stderr.write(
      `Hint: set MSSQL_TRUST_SERVER_CERT=true (self-signed dev certs) or MSSQL_ENCRYPT=false.\n`,
    );
  } else if (/login failed/i.test(message)) {
    process.stderr.write(`Hint: check MSSQL_USER, MSSQL_PASSWORD, and that the login is mapped to MSSQL_DATABASE.\n`);
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    process.stderr.write(`Hint: check MSSQL_SERVER host, MSSQL_PORT, and that the DB is reachable from here.\n`);
  }
  process.exit(1);
});
