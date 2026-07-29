import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { WaitCondition } from "@aart/types";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const keyLoads = new Map<string, Promise<Buffer>>();

async function readOrCreateKey(path: string): Promise<Buffer> {
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    const key = await fs.readFile(path);
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(
        `Invalid Aart wait-operation key at ${path}: expected ${KEY_BYTES} bytes.`,
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
        `Invalid Aart wait-operation key at ${path}: expected ${KEY_BYTES} bytes.`,
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
  return pending;
}

/**
 * Seals the operational wait condition independently from its public audit
 * copy. The adjacent key file is mode 0600 and never exposed through
 * AartStore; production storage can replace this adapter without changing
 * the WaitStore contract.
 */
export async function sealWaitOperation(
  keyPath: string,
  runId: string,
  stepId: string,
  generation: string,
  wait: WaitCondition,
): Promise<string> {
  const key = await loadKey(keyPath);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([runId, stepId, generation]),
      "utf8",
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(wait), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v2",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export async function openWaitOperation(
  keyPath: string,
  runId: string,
  stepId: string,
  generation: string | undefined,
  sealed: string,
): Promise<WaitCondition> {
  const [version, ivText, tagText, ciphertextText] = sealed.split(".");
  if (
    (version !== "v1" && version !== "v2") ||
    ivText === undefined ||
    tagText === undefined ||
    ciphertextText === undefined
  ) {
    throw new Error("Unsupported sealed wait-operation value.");
  }
  if (version === "v2" && generation === undefined) {
    throw new Error(
      "Sealed wait-operation generation is missing.",
    );
  }
  const key = await loadKey(keyPath);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(
    Buffer.from(
      JSON.stringify([
        runId,
        stepId,
        ...(version === "v2" ? [generation] : []),
      ]),
      "utf8",
    ),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as WaitCondition;
}
