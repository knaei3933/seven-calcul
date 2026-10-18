import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postgresPoolOptions } from "@/lib/db/postgres-client";

describe("application PostgreSQL TLS options", () => {
  it("keeps unconfigured local test connections plaintext", () => {
    expect(postgresPoolOptions(
      "postgresql://root:pouch-local-test@127.0.0.1:5433/pouch_test",
    ).ssl).toBeUndefined();
  });

  it("allows explicitly requested SSL for localhost while preserving local test behavior", () => {
    expect(postgresPoolOptions(
      "postgresql://root:test@localhost:5433/pouch_test?sslmode=require",
    ).ssl).toEqual({ rejectUnauthorized: false });
    expect(postgresPoolOptions(
      "postgresql://root:test@localhost:5433/pouch_test?sslmode=disable",
    ).ssl).toBe(false);
  });

  it("verifies remote certificates by default and for every secure SSL mode", () => {
    for (const connectionString of [
      "postgresql://app:scret@postgres.example.test:5432/pouch",
      "postgresql://app:scret@postgres.example.test:5432/pouch?sslmode=require",
      "postgresql://app:scret@postgres.example.test:5432/pouch?sslmode=verify-full",
      "postgresql://app:scret@postgres.example.test:5432/pouch?ssl=true",
    ]) {
      const options = postgresPoolOptions(connectionString);
      expect(options.ssl).toEqual({ rejectUnauthorized: true });
      expect(options.connectionString).not.toMatch(/ssl(mode)?=/u);
    }
  });

  it("rejects disabling TLS for a remote database", () => {
    expect(() => postgresPoolOptions(
      "postgresql://app:scret@postgres.example.test:5432/pouch?sslmode=disable",
    )).toThrow("TLS must not be disabled");
    expect(() => postgresPoolOptions(
      "postgresql://app:scret@postgres.example.test:5432/pouch?ssl=false",
    )).toThrow("TLS must not be disabled");
  });

  it("loads a URL-configured root CA without weakening hostname verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pouch-postgres-tls-"));
    const certificatePath = join(directory, "root-ca.pem");
    const rootCertificate = "-----BEGIN CERTIFICATE-----\nlocal-test\n-----END CERTIFICATE-----\n";
    await writeFile(certificatePath, rootCertificate);

    expect(postgresPoolOptions(
      `postgresql://app:scret@postgres.example.test:5432/pouch?sslmode=verify-ca&sslrootcert=${
        encodeURIComponent(certificatePath)
      }`,
    )).toMatchObject({
      connectionString: "postgresql://app:scret@postgres.example.test:5432/pouch",
      ssl: {
        ca: rootCertificate,
        rejectUnauthorized: true,
      },
    });
  });
});
