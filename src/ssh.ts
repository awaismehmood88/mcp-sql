import { createTunnel, type ForwardOptions, type ServerOptions, type SshOptions, type TunnelOptions } from "tunnel-ssh";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server, AddressInfo } from "node:net";
import type { SshConfig } from "./config.js";
import { log } from "./logger.js";

// Minimal surface we need from the ssh2 Client returned by createTunnel.
// Avoids pulling @types/ssh2 just for two lifecycle hooks.
interface MinimalSshClient {
  end(): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "end" | "close", handler: () => void): void;
}

export interface ActiveTunnel {
  localHost: string;
  localPort: number;
  close: () => Promise<void>;
}

const expandHome = (p: string): string => {
  if (!p.startsWith("~")) return p;
  return path.join(os.homedir(), p.slice(1));
};

const readPrivateKey = (rawPath: string): Buffer => {
  const fullPath = expandHome(rawPath);
  try {
    return fs.readFileSync(fullPath);
  } catch (err) {
    throw new Error(`Failed to read SSH private key at ${fullPath}: ${(err as Error).message}`);
  }
};

const portOf = (server: Server): number => {
  const addr = server.address();
  if (addr && typeof addr === "object") return (addr as AddressInfo).port;
  throw new Error("Tunnel server has no bound address.");
};

export const openSshTunnel = async (
  ssh: SshConfig,
  remoteHost: string,
  remotePort: number,
): Promise<ActiveTunnel> => {
  const sshOptions: SshOptions = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    // Generous keep-alive so idle tunnels don't drop mid-session.
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  };
  if (ssh.privateKeyPath) {
    sshOptions.privateKey = readPrivateKey(ssh.privateKeyPath);
    if (ssh.passphrase) sshOptions.passphrase = ssh.passphrase;
  } else if (ssh.password) {
    sshOptions.password = ssh.password;
  } else if (ssh.useAgent && ssh.agentSocket) {
    // ssh2 accepts an `agent` field (path to the unix socket) but the
    // tunnel-ssh type doesn't expose it — cast through to set it.
    (sshOptions as unknown as { agent: string }).agent = ssh.agentSocket;
  }

  const tunnelOptions: TunnelOptions = { autoClose: false, reconnectOnError: false };
  const serverOptions: ServerOptions = {
    host: "127.0.0.1",
    port: ssh.localPort && ssh.localPort > 0 ? ssh.localPort : 0,
  };
  const forwardOptions: ForwardOptions = {
    srcAddr: "127.0.0.1",
    srcPort: serverOptions.port ?? 0,
    dstAddr: remoteHost,
    dstPort: remotePort,
  };

  const authMethod = ssh.privateKeyPath
    ? "privateKey"
    : ssh.password
      ? "password"
      : ssh.useAgent
        ? "sshAgent"
        : "none";
  log.info("opening SSH tunnel", {
    sshHost: ssh.host,
    sshPort: ssh.port,
    sshUser: ssh.username,
    remote: `${remoteHost}:${remotePort}`,
    auth: authMethod,
  });

  const [server, conn] = await createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions);
  const localPort = portOf(server);
  log.info("SSH tunnel up", { localHost: "127.0.0.1", localPort });

  // Surface lifecycle events.
  const client = conn as unknown as MinimalSshClient;
  client.on("error", (err: Error) => log.error("ssh client error", { message: err.message }));
  client.on("end", () => log.warn("ssh connection ended"));
  client.on("close", () => log.warn("ssh connection closed"));
  server.on("error", (err: Error) => log.error("tunnel server error", { message: err.message }));

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      try {
        client.end();
      } catch {
        // ignore
      }
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    log.info("SSH tunnel closed");
  };

  return { localHost: "127.0.0.1", localPort, close };
};
