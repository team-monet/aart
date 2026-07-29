import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const keyLoads = new Map<string, Promise<Buffer>>();

async function readOrCreateKey(path: string): Promise<Buffer> {
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    const key = await fs.readFile(path);
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(
        `Invalid Aart operational-state key at ${path}: expected ${KEY_BYTES} bytes.`,
      );
    }
    await fs.chmod(path, 0o600);
    return key;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const generated = randomBytes(KEY_BYTES);
  try {
    await fs.writeFile(path, generated, {
      flag: "wx",
      mode: 0o600,
    });
    return generated;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const existing = await fs.readFile(path);
    if (existing.byteLength !== KEY_BYTES) {
      throw new Error(
        `Invalid Aart operational-state key at ${path}: expected ${KEY_BYTES} bytes.`,
      );
    }
    await fs.chmod(path, 0o600);
    return existing;
  }
}

function loadKey(path: string): Promise<Buffer> {
  const existing = keyLoads.get(path);
  if (existing) return existing;
  const pending = readOrCreateKey(path);
  keyLoads.set(path, pending);
  void pending.catch(() => {
    if (keyLoads.get(path) === pending) {
      keyLoads.delete(path);
    }
  });
  return pending;
}

export async function sealOperationalState(
  keyPath: string,
  aad: readonly string[],
  value: unknown,
): Promise<string> {
  const key = await loadKey(keyPath);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export async function openOperationalState<T>(
  keyPath: string,
  aad: readonly string[],
  sealed: string,
): Promise<T> {
  const [version, ivText, tagText, ciphertextText] = sealed.split(".");
  if (
    version !== "v1" ||
    ivText === undefined ||
    tagText === undefined ||
    ciphertextText === undefined
  ) {
    throw new Error("Unsupported sealed operational-state value.");
  }
  const key = await loadKey(keyPath);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(JSON.stringify(aad), "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
