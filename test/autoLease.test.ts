import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armLease,
  buildLease,
  clearLease,
  leaseCovers,
  readLease,
  LEASE_FILE,
} from "../src/gating/autoLease.js";

const tmp = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "lease-"));

test("buildLease computes until and scope", () => {
  const now = Date.parse("2026-01-01T10:00:00Z");
  const l = buildLease({ minutes: 15, now, armedBy: "me" });
  assert.equal(l.until, "2026-01-01T10:15:00.000Z");
  assert.equal(l.connections, null);
  const scoped = buildLease({ minutes: 5, now, connections: [" hrms "], armedBy: "me" });
  assert.deepEqual(scoped.connections, ["hrms"]);
});

test("buildLease rejects bad durations", () => {
  assert.throws(() => buildLease({ minutes: 0 }), /positive/);
  assert.throws(() => buildLease({ minutes: 301 }), /capped/);
  assert.throws(() => buildLease({ minutes: 2.5 }), /positive/);
});

test("leaseCovers respects expiry and connection scope", () => {
  const now = Date.parse("2026-01-01T10:00:00Z");
  const all = buildLease({ minutes: 10, now, armedBy: "me" });
  assert.equal(leaseCovers(all, "hrms", now + 1000), true);
  assert.equal(leaseCovers(all, "hrms", now + 11 * 60_000), false);
  const only = buildLease({ minutes: 10, now, connections: ["psa-edu"], armedBy: "me" });
  assert.equal(leaseCovers(only, "PSA-EDU", now), true);
  assert.equal(leaseCovers(only, "hrms", now), false);
});

test("arm / read / clear round-trip; expired lease is removed on read", async () => {
  const dir = await tmp();
  assert.equal(await readLease(dir), null);
  const armed = await armLease(dir, { minutes: 5, armedBy: "me" });
  const read = await readLease(dir);
  assert.equal(read?.until, armed.until);
  assert.equal(await clearLease(dir), true);
  assert.equal(await clearLease(dir), false);

  await armLease(dir, { minutes: 5, armedBy: "me", now: Date.now() - 10 * 60_000 });
  assert.equal(await readLease(dir), null);
  await assert.rejects(fs.stat(path.join(dir, LEASE_FILE)));
});

test("garbage lease file is removed on read", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, LEASE_FILE), "{not json", "utf8");
  assert.equal(await readLease(dir), null);
  await assert.rejects(fs.stat(path.join(dir, LEASE_FILE)));
});

test("sweepPendingUnderLease approves only covered pending requests", async () => {
  const { createRequest, readRequest } = await import("../src/gating/dualStage.js");
  const { sweepPendingUnderLease } = await import("../src/gating/autoApprove.js");
  const dir = await tmp();
  const a = await createRequest(dir, "SELECT 1", "hrms");
  const b = await createRequest(dir, "SELECT 2", "psa-edu");
  const lease = buildLease({ minutes: 5, connections: ["hrms"], armedBy: "me" });
  const swept = await sweepPendingUnderLease(dir, lease);
  assert.deepEqual(swept.map((r) => r.id), [a.id]);
  assert.equal((await readRequest(dir, a.id))?.status, "approved");
  assert.equal((await readRequest(dir, b.id))?.status, "pending");
  // second sweep is a no-op
  assert.equal((await sweepPendingUnderLease(dir, lease)).length, 0);
});
