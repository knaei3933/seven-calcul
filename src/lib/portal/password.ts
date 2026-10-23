import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PASSWORD_KEY_LENGTH = 64;
const ALGORITHM = "portal-scrypt";

/**
 * Portal hashes are intentionally namespaced away from internal admin hashes.
 * A hash created by either authentication domain cannot be replayed in the other.
 */
export async function hashPortalPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(
    password.normalize("NFKC"),
    salt,
    PASSWORD_KEY_LENGTH,
    SCRYPT_PARAMETERS,
  );
  return [
    ALGORITHM,
    SCRYPT_PARAMETERS.N,
    SCRYPT_PARAMETERS.r,
    SCRYPT_PARAMETERS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPortalPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [algorithm, n, r, p, saltText, hashText] = storedHash.split("$");
  if (algorithm !== ALGORITHM || !n || !r || !p || !saltText || !hashText) return false;

  const parameters = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_PARAMETERS.maxmem,
  };
  if (
    !Number.isInteger(parameters.N) || parameters.N < 16384
    || !Number.isInteger(parameters.r) || parameters.r < 1
    || !Number.isInteger(parameters.p) || parameters.p < 1
  ) return false;

  const expected = Buffer.from(hashText, "base64url");
  if (expected.length < 16 || expected.length > 128) return false;
  const actual = await scrypt(
    password.normalize("NFKC"),
    Buffer.from(saltText, "base64url"),
    expected.length,
    parameters,
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
