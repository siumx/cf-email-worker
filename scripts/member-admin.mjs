import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

try {
  const destination = resolve(process.argv[2] ?? ".dev.vars");
  let content = "";
  try { content = await readFile(destination, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const variables = parseEnv(content);
  const existing = (key) => variables[key] ?? null;
  const pepper = existing("MEMBER_PASSWORD_PEPPER") ?? randomBytes(32).toString("base64url");
  const jwtSecret = existing("MEMBER_JWT_SECRET") ?? randomBytes(32).toString("base64url");
  if (typeof pepper !== "string" || !pepper || typeof jwtSecret !== "string" || !jwtSecret) {
    throw new Error("Existing pepper or JWT secret is invalid; no file was changed.");
  }
  const secrets = { MEMBER_PASSWORD_PEPPER: pepper, MEMBER_JWT_SECRET: jwtSecret };
  const output = Object.entries({ ...variables, ...secrets }).filter(([key]) => key !== "MEMBER_ADMIN_PASSWORD_HASH")
    .map(([key, value]) => {
      for (const quote of ["'", '"']) {
        if (value.includes(quote)) continue;
        const line = `${key}=${quote}${value}${quote}`;
        if (parseEnv(line)[key] === value) return line;
      }
      throw new Error(`Cannot safely serialize ${key}; no file was changed.`);
    }).join("\n") + "\n";
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, output, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Pepper and JWT secret saved to ${destination}. Set MEMBER.password in wrangler [vars].`);
  console.log("Upload with: npx wrangler secret bulk <that-file> -c <your-wrangler-config>");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
