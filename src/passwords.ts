import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PARAMETERS = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };

export interface PasswordRecord {
  v: 1;
  algorithm: "scrypt-hmac-sha256";
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length > 0 && password.length <= 128;
}

export function parsePasswordRecord(value: string): PasswordRecord {
  const record = JSON.parse(value) as PasswordRecord;
  if (!record || record.v !== 1 || record.algorithm !== "scrypt-hmac-sha256" ||
    record.N !== PARAMETERS.N || record.r !== PARAMETERS.r || record.p !== PARAMETERS.p ||
    typeof record.salt !== "string" || !/^[a-f0-9]{32}$/.test(record.salt) ||
    typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)) {
    throw new Error("Invalid password record");
  }
  return record;
}

async function derivePassword(password: string, salt: string, pepper: string): Promise<Uint8Array> {
  const key = await new Promise<Uint8Array>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "hex"), 32, PARAMETERS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
  return createHmac("sha256", pepper).update(key).digest();
}

export async function createPasswordRecord(password: string, pepper: string): Promise<string> {
  if (!validPassword(password)) throw new Error("Password must contain 1–128 characters");
  if (!pepper) throw new Error("Password pepper is missing");
  const salt = randomBytes(16).toString("hex");
  const hash = Buffer.from(await derivePassword(password, salt, pepper)).toString("hex");
  return JSON.stringify({ v: 1, algorithm: "scrypt-hmac-sha256", N: PARAMETERS.N, r: PARAMETERS.r, p: PARAMETERS.p, salt, hash });
}

export async function verifyPassword(password: string, encoded: string, pepper: string): Promise<boolean> {
  const record = parsePasswordRecord(encoded);
  const derived = await derivePassword(password, record.salt, pepper);
  return timingSafeEqual(derived, Buffer.from(record.hash, "hex"));
}

export function equalPassword(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
