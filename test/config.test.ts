import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConnections, getConnection, loadConfig } from "../src/config.js";

const base = { MSSQL_USER: "ro", MSSQL_PASSWORD: "pw", MSSQL_SERVER: "db.local" };

test("legacy single connection from unprefixed vars", () => {
  const conns = loadConnections({ ...base, MSSQL_DATABASE: "Shop" });
  assert.equal(conns.length, 1);
  assert.equal(conns[0]!.tag, "Shop");
  assert.equal(conns[0]!.description, "Shop");
  assert.equal(conns[0]!.mssql.server, "db.local");
  assert.equal(conns[0]!.mssql.port, 1433);
});

test("legacy tag comes from MCP_SOURCE_LABEL", () => {
  const conns = loadConnections({ ...base, MSSQL_DATABASE: "Shop", MCP_SOURCE_LABEL: "shop-prod" });
  assert.equal(conns[0]!.tag, "shop-prod");
});

test("multi-connection with per-tag overrides and shared fallbacks", () => {
  const conns = loadConnections({
    ...base,
    MSSQL_CONNECTIONS: "psa-edu, hrms",
    MSSQL_PSA_EDU_DATABASE: "PsaEdu",
    MSSQL_PSA_EDU_DESCRIPTION: "Education portal",
    MSSQL_HRMS_DATABASE: "Hrms",
    MSSQL_HRMS_SERVER: "hr.local",
    MSSQL_HRMS_PORT: "1444",
    MSSQL_HRMS_USER: "hr_ro",
  });
  assert.deepEqual(
    conns.map((c) => c.tag),
    ["psa-edu", "hrms"],
  );
  const edu = conns[0]!;
  assert.equal(edu.description, "Education portal");
  assert.equal(edu.mssql.server, "db.local");
  assert.equal(edu.mssql.user, "ro");
  const hr = conns[1]!;
  assert.equal(hr.description, "Hrms");
  assert.equal(hr.mssql.server, "hr.local");
  assert.equal(hr.mssql.port, 1444);
  assert.equal(hr.mssql.user, "hr_ro");
  assert.equal(hr.mssql.password, "pw");
});

test("per-tag SSH falls back to shared MSSQL_SSH_* vars", () => {
  const conns = loadConnections({
    ...base,
    MSSQL_CONNECTIONS: "a,b",
    MSSQL_A_DATABASE: "A",
    MSSQL_B_DATABASE: "B",
    MSSQL_B_SSH_ENABLED: "true",
    MSSQL_SSH_HOST: "bastion",
    MSSQL_SSH_USER: "ops",
    MSSQL_SSH_PASSWORD: "s3cret",
  });
  assert.equal(conns[0]!.ssh, null);
  assert.equal(conns[1]!.ssh?.host, "bastion");
  assert.equal(conns[1]!.ssh?.username, "ops");
});

test("missing per-tag database fails with a helpful name", () => {
  assert.throws(
    () => loadConnections({ ...base, MSSQL_CONNECTIONS: "hrms" }),
    /MSSQL_HRMS_DATABASE/,
  );
});

test("bad and duplicate tags are rejected", () => {
  assert.throws(() => loadConnections({ ...base, MSSQL_CONNECTIONS: "bad tag" }), /must match/);
  assert.throws(
    () =>
      loadConnections({
        ...base,
        MSSQL_CONNECTIONS: "psa-edu,psa_edu",
        MSSQL_PSA_EDU_DATABASE: "X",
      }),
    /Duplicate/,
  );
});

test("getConnection resolves by tag, defaults only when one exists", () => {
  const single = loadConfig({ ...base, MSSQL_DATABASE: "Shop" });
  assert.equal(getConnection(single).tag, "Shop");
  assert.equal(getConnection(single, "shop").tag, "Shop");

  const multi = loadConfig({
    ...base,
    MSSQL_CONNECTIONS: "a,b",
    MSSQL_A_DATABASE: "A",
    MSSQL_B_DATABASE: "B",
  });
  assert.equal(getConnection(multi, "B").tag, "b");
  assert.throws(() => getConnection(multi), /required/);
  assert.throws(() => getConnection(multi, "zzz"), /Unknown connection/);
});
