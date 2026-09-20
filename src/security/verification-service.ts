import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ProjectId, TelegramUserId } from "../contracts/ids.js";
import type { TenantProofConfig } from "../contracts/proof-config.js";
import { decodeNonce, formatWalletMessage, validateWalletMessage, WALLET_PROOF_LIFETIME_MS } from "./wallet-message.js";
import { verifyWalletSignature } from "./signature-verifier.js";

/**
 * Derived by the caller exclusively from an already-authenticated session.
 * Nothing in a request body may reach these fields.
 */
export interface WalletProofIdentity {
  readonly projectId: ProjectId;
  readonly userId: TelegramUserId | string;
}
interface StoredRequest {
  requestId: string; telegramUserId: string; walletAddress: string | null;
  nonceHash: Buffer; origin: string; chain: string; issuedAt: Date; expiresAt: Date; status: string;
}
export interface VerificationStore {
  databaseNow(): Promise<Date>;
  insert(input: Omit<StoredRequest, "status" | "walletAddress"> & { walletAddress: string }): Promise<unknown>;
  findByRequestId(requestId: string): Promise<StoredRequest | undefined>;
  verifySignature(input: { requestId: string; telegramUserId: string; walletAddress: string; nonceHash: Buffer; issuedAt: Date; expiresAt: Date }): Promise<boolean>;
}
export class WalletProofError extends Error {
  constructor() { super("invalid wallet proof"); this.name = "WalletProofError"; }
}
function nonceDigest(projectId: string, requestId: string, nonce: string): Buffer {
  // UUID text has fixed width; nonce is decoded to its original 32 random bytes.
  return createHash("sha256").update(projectId).update(requestId).update(decodeNonce(nonce)).digest();
}
export async function createVerificationRequest(store: VerificationStore, identity: WalletProofIdentity, walletAddress: string, tenant: TenantProofConfig) {
  // Issuance and expiry are judged by PostgreSQL later, so issue them from the
  // same clock. App and database hosts are allowed to have small clock skew.
  const issuedAt = await store.databaseNow();
  const fields = { walletAddress, origin: tenant.origin, chain: tenant.chain, requestId: randomUUID(),
    nonce: randomBytes(32).toString("base64url"), issuedAt,
    expiresAt: new Date(issuedAt.getTime() + WALLET_PROOF_LIFETIME_MS) };
  const message = formatWalletMessage(fields, tenant);
  await store.insert({ requestId: fields.requestId, telegramUserId: identity.userId, walletAddress,
    nonceHash: nonceDigest(identity.projectId, fields.requestId, fields.nonce), origin: fields.origin, chain: fields.chain,
    issuedAt, expiresAt: fields.expiresAt });
  return { requestId: fields.requestId, nonce: fields.nonce, message };
}
export interface WalletProofSubmission {
  requestId: string; nonce: string; message: string; signature: string;
}
/** No raw signature is passed to persistence or included in errors/results. */
export async function consumeWalletProof(store: VerificationStore, identity: WalletProofIdentity, input: WalletProofSubmission, tenant: TenantProofConfig): Promise<{ status: "signature_verified" }> {
  let signature: Buffer | undefined;
  try {
    if (!/^[A-Za-z0-9_-]{86}$/.test(input.signature)) throw new WalletProofError();
    signature = Buffer.from(input.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== input.signature) throw new WalletProofError();
    input.signature = "";
    const row = await store.findByRequestId(input.requestId);
    // A request issued under a different origin or chain than this tenant now
    // presents is not this tenant's request, whatever else matches.
    if (!row || row.status !== "pending" || row.telegramUserId !== identity.userId || !row.walletAddress ||
        row.origin !== tenant.origin || row.chain !== tenant.chain) throw new WalletProofError();
    const now = await store.databaseNow();
    const digest = nonceDigest(identity.projectId, input.requestId, input.nonce);
    if (row.nonceHash.length !== 32 || !timingSafeEqual(row.nonceHash, digest) ||
        !validateWalletMessage(input.message, { ...row, walletAddress: row.walletAddress, nonce: input.nonce }, now, tenant) ||
        !verifyWalletSignature(input.message, signature, row.walletAddress)) throw new WalletProofError();
    signature.fill(0);
    signature = undefined;
    if (!await store.verifySignature({ requestId: row.requestId, telegramUserId: identity.userId,
      walletAddress: row.walletAddress, nonceHash: digest, issuedAt: row.issuedAt, expiresAt: row.expiresAt })) throw new WalletProofError();
    return { status: "signature_verified" };
  } finally {
    signature?.fill(0);
    input.signature = "";
  }
}
