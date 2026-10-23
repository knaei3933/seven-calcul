import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const peerRoot = process.env.PORTAL_CONTRACT_PEER_ROOT;

describe("portal-api-v1 contract fixture", () => {
  it("requires a configured portal peer root with an actionable error", () => {
    const previousPeerRoot = process.env.PORTAL_CONTRACT_PEER_ROOT;
    delete process.env.PORTAL_CONTRACT_PEER_ROOT;
    const result = spawnSync("node", [path.join(root, "scripts/verify-portal-api-v1-contract.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    if (previousPeerRoot === undefined) delete process.env.PORTAL_CONTRACT_PEER_ROOT;
    else process.env.PORTAL_CONTRACT_PEER_ROOT = previousPeerRoot;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PORTAL_CONTRACT_PEER_ROOT is required");
    expect(result.stderr).toContain("Set it to the absolute path of the peer repository root");
  });

  it.skipIf(!peerRoot)("matches the committed checksum and the configured portal peer", () => {
    const result = spawnSync("node", [path.join(root, "scripts/verify-portal-api-v1-contract.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^portal-api-v1 fixture verified: sha256=[0-9a-f]{64}$/m);
  });

  it("does not commit fixture secret values", () => {
    const fixture = JSON.parse(readFileSync(path.join(root, "contracts/portal-api-v1.json"), "utf8"));
    expect(fixture.secretHandling.fixtureContainsSecrets).toBe(false);
    expect(fixture.secretHandling.committedSecretValues).toEqual([]);
  });
});
