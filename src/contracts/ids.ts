import { ValidationError } from "./errors.js";

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type TelegramUserId = string & { readonly __brand: "TelegramUserId" };
export type WalletAddress = string & { readonly __brand: "WalletAddress" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const BASE58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseProjectId(value: string): ProjectId {
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError("ProjectId must be a UUID");
  }
  return value as ProjectId;
}

export function parseTelegramUserId(value: string): TelegramUserId {
  if (!TELEGRAM_USER_ID_PATTERN.test(value)) {
    throw new ValidationError("TelegramUserId must be a positive numeric string");
  }
  return value as TelegramUserId;
}

/** Also used to validate Solana mint addresses, which share the same base58 shape as wallet addresses. */
export function parseWalletAddress(value: string): WalletAddress {
  if (!BASE58_ADDRESS_PATTERN.test(value)) {
    throw new ValidationError("WalletAddress must be a base58-encoded Solana address");
  }
  return value as WalletAddress;
}

export function parseRawTokenAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError("raw token amount must be a non-negative integer string");
  }
  return BigInt(value);
}

export function parseThreshold(value: string): bigint {
  const amount = parseRawTokenAmount(value);
  if (amount < 1n) {
    throw new ValidationError("threshold must be at least one raw unit");
  }
  return amount;
}
