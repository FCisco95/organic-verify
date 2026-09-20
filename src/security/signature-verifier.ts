import { createPublicKey, verify } from "node:crypto";
import { decodeWalletAddress } from "./wallet-message.js";

// Small-order y coordinates, both signs; mathematical constants from libsodium:
// https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c#L966
const SMALL_ORDER_Y = new Set([
  "00".repeat(32), "01" + "00".repeat(31),
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ec" + "ff".repeat(30) + "7f",
]);
function acceptablePoint(bytes: Uint8Array): boolean {
  const y = Buffer.from(bytes);
  y[31] = y[31]! & 0x7f;
  return !SMALL_ORDER_Y.has(y.toString("hex")) &&
    BigInt("0x" + y.reverse().toString("hex")) < (1n << 255n) - 19n;
}

/** Detached Ed25519 verification only; this module has no signing capability. */
export function verifyWalletSignature(message: string, signature: Uint8Array, walletAddress: string): boolean {
  try {
    if (signature.length !== 64) return false;
    const publicBytes = decodeWalletAddress(walletAddress);
    if (!acceptablePoint(publicBytes) || !acceptablePoint(signature.subarray(0, 32))) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]),
      format: "der", type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch { return false; }
}
