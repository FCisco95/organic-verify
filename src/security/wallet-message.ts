import bs58 from "bs58";
import { parseTenantProofConfig, type TenantProofConfig } from "../contracts/proof-config.js";

export const WALLET_PROOF_LIFETIME_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * Appended by this module, never supplied by a tenant. A caller cannot remove
 * or reword it, so every message this platform issues says the same thing
 * about what signing it does not authorize.
 */
const NON_AUTHORIZATION = "This does not authorize a transaction or token approval.";
export interface WalletMessageFields {
  readonly walletAddress: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** The origin and chain recorded on the stored request; both must still match the tenant config. */
  readonly origin: string;
  readonly chain: string;
}
export function decodeWalletAddress(address: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("invalid wallet proof");
  const bytes = bs58.decode(address);
  if (bytes.length !== 32 || bs58.encode(bytes) !== address) throw new Error("invalid wallet proof");
  return bytes;
}
export function decodeNonce(nonce: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("invalid wallet proof");
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== nonce) throw new Error("invalid wallet proof");
  return bytes;
}
/**
 * The whole tenant config is re-validated on every call rather than trusted
 * from construction. This function is the last point before bytes a wallet
 * will display, it is reached from both issuance and verification, and it is
 * exported to consumers who can hand over any object the type allows. An
 * unchecked newline in `statement` or `productName` would forge a message
 * line, so the check is here rather than at the caller's boundary.
 */
function checkedTenant(tenant: TenantProofConfig): { readonly config: TenantProofConfig; readonly domain: string } {
  try {
    const config = parseTenantProofConfig(tenant);
    // `host`, not `hostname`: a non-default port is part of what a member
    // compares against their address bar, and dropping it would let two
    // distinct bound origins render the same Domain line.
    return { config, domain: new URL(config.origin).host };
  } catch {
    throw new Error("invalid wallet proof");
  }
}
/** Canonical UTF-8 text, LF separators, millisecond UTC timestamps, no trailing LF. */
export function formatWalletMessage(fields: WalletMessageFields, tenant: TenantProofConfig): string {
  decodeWalletAddress(fields.walletAddress);
  decodeNonce(fields.nonce);
  const { config, domain } = checkedTenant(tenant);
  if (fields.origin !== config.origin || fields.chain !== config.chain || !UUID.test(fields.requestId) ||
      !Number.isFinite(fields.issuedAt.getTime()) ||
      fields.expiresAt.getTime() - fields.issuedAt.getTime() !== WALLET_PROOF_LIFETIME_MS) {
    throw new Error("invalid wallet proof");
  }
  return [`${config.productName} wallet verification`, "", `Domain: ${domain}`,
    `Statement: ${config.statement} ${NON_AUTHORIZATION}`,
    `Wallet: ${fields.walletAddress}`, `Request ID: ${fields.requestId}`, `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`, `Expiration Time: ${fields.expiresAt.toISOString()}`,
    `Chain ID: ${config.chain}`].join("\n");
}
export function validateWalletMessage(message: string, fields: WalletMessageFields, now: Date, tenant: TenantProofConfig): boolean {
  try {
    return Number.isFinite(now.getTime()) && fields.issuedAt <= now && now < fields.expiresAt && message === formatWalletMessage(fields, tenant);
  } catch { return false; }
}
