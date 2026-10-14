#!/usr/bin/env node
// SSH-only connectivity test. Useful for isolating SSH/bastion issues from
// MSSQL issues. Opens each configured SSH tunnel, prints the bound local
// port, closes it. Does NOT connect to the database.
//   npm run test:ssh            → every connection that has SSH enabled
//   npm run test:ssh -- <tag>   → just that one

import net from "node:net";
import { getConnection, loadConfig, type ConnectionConfig } from "../config.js";
import { openSshTunnel } from "../ssh.js";

const probeLocalPort = (host: string, port: number, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const done = (err?: Error): void => {
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`probe timed out after ${timeoutMs}ms`)));
    socket.once("error", done);
    socket.connect(port, host, () => done());
  });

const checkOne = async (conn: ConnectionConfig): Promise<boolean> => {
  const ssh = conn.ssh;
  if (!ssh) {
    process.stderr.write(`[${conn.tag}] SSH not enabled — skipped.\n\n`);
    return true;
  }
  process.stderr.write(
    `[${conn.tag}] Opening SSH tunnel:\n` +
      `  bastion: ${ssh.username}@${ssh.host}:${ssh.port}\n` +
      `  auth   : ${
        ssh.privateKeyPath
          ? `privateKey (${ssh.privateKeyPath})`
          : ssh.password
            ? "password"
            : ssh.useAgent
              ? `ssh-agent (${ssh.agentSocket})`
              : "none"
      }\n` +
      `  forward: 127.0.0.1:${ssh.localPort || "auto"} → ${conn.mssql.server}:${conn.mssql.port}\n`,
  );

  try {
    const start = Date.now();
    const tunnel = await openSshTunnel(ssh, conn.mssql.server, conn.mssql.port);
    const tunnelMs = Date.now() - start;
    process.stdout.write(
      `[${conn.tag}] OK — SSH tunnel established in ${tunnelMs} ms, bound to 127.0.0.1:${tunnel.localPort}\n`,
    );
    try {
      await probeLocalPort(tunnel.localHost, tunnel.localPort);
      process.stdout.write(`  probe   127.0.0.1:${tunnel.localPort} accepted a TCP connection ✓\n`);
    } catch (err) {
      process.stdout.write(`  probe   127.0.0.1:${tunnel.localPort} FAILED: ${(err as Error).message}\n`);
    }
    await tunnel.close();
    process.stdout.write("\n");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${conn.tag}] FAILED: ${message}\n`);
    if (/private key|passphrase|key rejected/i.test(message)) {
      process.stderr.write(
        `Hint: check the SSH_PRIVATE_KEY_PATH for this connection points at the right key, and set\n` +
          `      SSH_PASSPHRASE if the key is encrypted.\n`,
      );
    } else if (/authentication|All configured authentication methods failed/i.test(message)) {
      process.stderr.write(
        `Hint: SSH auth failed. Verify SSH_USER, the key (or password),\n` +
          `      and that the public key is in authorized_keys on the bastion.\n`,
      );
    } else if (/ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
      process.stderr.write(
        `Hint: cannot reach the bastion. Check SSH_HOST/SSH_PORT and\n` +
          `      that you can SSH to it manually: ssh ${ssh.username}@${ssh.host}\n`,
      );
    }
    process.stderr.write("\n");
    return false;
  }
};

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const wanted = process.argv[2];
  const targets = wanted ? [getConnection(cfg, wanted)] : cfg.connections;
  if (targets.every((c) => c.ssh === null)) {
    process.stderr.write(
      `SSH is not enabled on any ${wanted ? "selected" : "configured"} connection.\n` +
        `Set MSSQL_SSH_ENABLED=true (or MSSQL_<TAG>_SSH_ENABLED=true) and the related SSH_* vars.\n`,
    );
    process.exit(0);
  }
  let failures = 0;
  for (const conn of targets) {
    if (!(await checkOne(conn))) failures++;
  }
  if (failures > 0) {
    process.stderr.write(`${failures} SSH tunnel(s) FAILED.\n`);
    process.exit(1);
  }
  process.stdout.write(`SSH path looks healthy. Next: run 'npm run test:db' to verify MSSQL connects through it.\n`);
};

main().catch((err) => {
  process.stderr.write(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
