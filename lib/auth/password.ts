import "server-only";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const HASH_BYTES = 64;
const FORMAT = "scrypt-v1";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, HASH_BYTES) as Buffer;
  return `${FORMAT}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [format, encodedSalt, encodedHash, extra] = stored.split("$");
  if (format !== FORMAT || !encodedSalt || !encodedHash || extra) return false;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expected = Buffer.from(encodedHash, "base64url");
    if (salt.length !== 16 || expected.length !== HASH_BYTES) return false;
    const supplied = await scrypt(password, salt, expected.length) as Buffer;
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}
