import {
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
  type xdr as XDR,
} from "@stellar/stellar-sdk";

export type NativeScVal =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | NativeScVal[]
  | { [key: string]: NativeScVal };

function isScVal(value: unknown): value is XDR.ScVal {
  return Boolean(value) && typeof value === "object" && "toXDR" in (value as object);
}

/**
 * Convert a JavaScript value into a Soroban ScVal.
 * Accepts addresses, bytes, bigints, and nested objects/arrays.
 */
export function serializeScVal(
  value: unknown,
  type?: "address" | "bytes" | "u32" | "u64" | "i128" | "bool" | "symbol" | "string",
): XDR.ScVal {
  if (isScVal(value)) {
    return value;
  }

  if (type === "address" && typeof value === "string") {
    return new Address(value).toScVal();
  }
  if (type === "bytes") {
    const bytes =
      typeof value === "string" ? hexToBytes(value) : (value as Uint8Array);
    return nativeToScVal(Buffer.from(bytes), { type: "bytes" });
  }
  if (type === "u32") return nativeToScVal(Number(value), { type: "u32" });
  if (type === "u64") return nativeToScVal(BigInt(value as number | bigint | string), { type: "u64" });
  if (type === "i128") return nativeToScVal(BigInt(value as number | bigint | string), { type: "i128" });
  if (type === "bool") return nativeToScVal(Boolean(value), { type: "bool" });
  if (type === "symbol") return nativeToScVal(String(value), { type: "symbol" });
  if (type === "string") return nativeToScVal(String(value), { type: "string" });

  if (typeof value === "string" && (value.startsWith("G") || value.startsWith("C"))) {
    try {
      return new Address(value).toScVal();
    } catch {
      return nativeToScVal(value);
    }
  }

  if (value instanceof Uint8Array) {
    return nativeToScVal(Buffer.from(value), { type: "bytes" });
  }

  return nativeToScVal(value as Parameters<typeof nativeToScVal>[0]);
}

/**
 * Decode an ScVal (or base64 XDR) into a plain JavaScript value.
 */
export function deserializeScVal(value: XDR.ScVal | string): unknown {
  const scVal =
    typeof value === "string" ? xdr.ScVal.fromXDR(value, "base64") : value;
  return scValToNative(scVal);
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array | Buffer | number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function toI128String(amount: bigint | number | string): string {
  return BigInt(amount).toString();
}
