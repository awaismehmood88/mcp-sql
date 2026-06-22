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
  if (/no route to host|Channel open failure/i.test(message)) {
    process.stderr.write(
      `Hint: SSH connected, but the BASTION cannot reach ${process.env.MSSQL_SERVER}:${process.env.MSSQL_PORT ?? 1433}.\n` +
        `      Test from the bastion:\n` +
        `        ssh ${process.env.MSSQL_SSH_USER}@${process.env.MSSQL_SSH_HOST} \\\n` +
        `          "timeout 3 bash -c '</dev/tcp/${process.env.MSSQL_SERVER}/${process.env.MSSQL_PORT ?? 1433}' && echo OPEN || echo BLOCKED"\n` +
        `      If BLOCKED, the bastion isn't on a network with route+ACL to the DB.\n` +
        `      The DB may need a different bastion, or a different IP/hostname from the bastion's POV.\n`,
    );
  } else if (/encrypt/i.test(message)) {
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
