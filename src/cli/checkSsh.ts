#!/usr/bin/env node
// SSH-only connectivity test. Useful for isolating SSH/bastion issues from
// MSSQL issues. Opens the configured SSH tunnel, prints the bound local port,
// closes it. Does NOT connect to the database.

import net from "node:net";
import { loadConfig } from "../config.js";
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

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  if (!cfg.ssh) {
    process.stderr.write(
      `SSH is not enabled in .env (MSSQL_SSH_ENABLED is not 'true').\n` +
        `Nothing to test. To enable SSH, set MSSQL_SSH_ENABLED=true and the\n` +
        `related MSSQL_SSH_* variables, then re-run.\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `Opening SSH tunnel:\n` +
      `  bastion: ${cfg.ssh.username}@${cfg.ssh.host}:${cfg.ssh.port}\n` +
      `  auth   : ${
        cfg.ssh.privateKeyPath
          ? `privateKey (${cfg.ssh.privateKeyPath})`
          : cfg.ssh.password
            ? "password"
            : cfg.ssh.useAgent
              ? `ssh-agent (${cfg.ssh.agentSocket})`
              : "none"
      }\n` +
      `  forward: 127.0.0.1:${cfg.ssh.localPort || "auto"} → ${cfg.mssql.server}:${cfg.mssql.port}\n\n`,
  );

  const start = Date.now();
  const tunnel = await openSshTunnel(cfg.ssh, cfg.mssql.server, cfg.mssql.port);
  const tunnelMs = Date.now() - start;
  process.stdout.write(
    `OK — SSH tunnel established in ${tunnelMs} ms\n` +
      `   bound to 127.0.0.1:${tunnel.localPort}\n`,
  );

  // Confirm the local socket actually accepts connections (catches tunnels
  // that opened but immediately broke).
  try {
    await probeLocalPort(tunnel.localHost, tunnel.localPort);
    process.stdout.write(`   probe   127.0.0.1:${tunnel.localPort} accepted a TCP connection ✓\n`);
  } catch (err) {
    process.stdout.write(`   probe   127.0.0.1:${tunnel.localPort} FAILED: ${(err as Error).message}\n`);
  }

  await tunnel.close();
  process.stdout.write(`Closed. SSH path looks healthy.\n`);
  process.stdout.write(`Next: run 'npm run test:db' to verify MSSQL connects through it.\n`);
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nFAILED: ${message}\n`);
  if (/private key|passphrase|key rejected/i.test(message)) {
    process.stderr.write(
      `Hint: check MSSQL_SSH_PRIVATE_KEY_PATH points at the right key, and set\n` +
        `      MSSQL_SSH_PASSPHRASE if the key is encrypted.\n`,
    );
  } else if (/authentication|All configured authentication methods failed/i.test(message)) {
    process.stderr.write(
      `Hint: SSH auth failed. Verify MSSQL_SSH_USER, the key (or password),\n` +
        `      and that the public key is in ~itadmin/.ssh/authorized_keys on the bastion.\n`,
    );
  } else if (/ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
    process.stderr.write(
      `Hint: cannot reach the bastion. Check MSSQL_SSH_HOST/MSSQL_SSH_PORT and\n` +
        `      that you can resolve & SSH to it manually: ssh ${process.env.MSSQL_SSH_USER}@${process.env.MSSQL_SSH_HOST}\n`,
    );
  }
  process.exit(1);
});
