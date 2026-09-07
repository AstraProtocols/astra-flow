import { createHash } from "node:crypto";
import { AstraFlowError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./converters.js";

export type HashInput = string | Uint8Array | ArrayBuffer | Buffer;

function toBytes(input: HashInput): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Uint8Array) return input;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new AstraFlowError("Unsupported hash input", { code: "BAD_HASH" });
}

export function sha256Sync(input: HashInput): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(toBytes(input))).digest());
}

export async function sha256(input: HashInput): Promise<Uint8Array> {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", Buffer.from(bytes));
    return new Uint8Array(digest);
  }
  return sha256Sync(bytes);
}

export function sha256HexSync(input: HashInput): string {
  return bytesToHex(sha256Sync(input));
}

export async function sha256Hex(input: HashInput): Promise<string> {
  return bytesToHex(await sha256(input));
}

export function hashProofAsset(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new AstraFlowError("Cannot hash an empty proof asset", { code: "BAD_HASH" });
  }
  return sha256HexSync(bytes);
}

export function hashMilestoneDocument(document: string | Uint8Array): string {
  return sha256HexSync(document);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i]! ^ b[i]!;
  }
  return mismatch === 0;
}

export function assertSha256Hex(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new AstraFlowError("Expected a 32-byte SHA-256 hex digest", { code: "BAD_HASH" });
  }
  return hexToBytes(normalized);
}

export function verifyHash(input: HashInput, expectedHex: string): boolean {
  const actual = sha256Sync(input);
  const expected = assertSha256Hex(expectedHex);
  return timingSafeEqual(actual, expected);
}
