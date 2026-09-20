/** Public SDK facade. Detached message verification and read-only balance evidence. */
export type { ProjectId, TelegramUserId, WalletAddress } from "./contracts/ids.js";
export type { Evidence, BalanceReader } from "./contracts/balance.js";
export type { TenantProofConfig } from "./contracts/proof-config.js";
export type { WalletMessageFields } from "./security/wallet-message.js";
export type { WalletProofIdentity, WalletProofSubmission, VerificationStore } from "./security/verification-service.js";
export type { TokenBalance, BalanceConsensusInput } from "./solana/balance-consensus.js";
export type { HoldCheckInput, HoldCheckResult } from "./hold-check.js";

export { parseProjectId, parseTelegramUserId, parseWalletAddress, parseRawTokenAmount, parseThreshold } from "./contracts/ids.js";
export { formatWalletMessage, validateWalletMessage, decodeWalletAddress, decodeNonce, WALLET_PROOF_LIFETIME_MS } from "./security/wallet-message.js";
export { createVerificationRequest, consumeWalletProof, WalletProofError } from "./security/verification-service.js";
export { verifyWalletSignature } from "./security/signature-verifier.js";
export { HeliusBalanceReader, FallbackBalanceReader, ProviderUnavailable } from "./solana/rpc-reader.js";
export { readBalanceConsensus } from "./solana/balance-consensus.js";
export { meetsThreshold, validAddress } from "./solana/token-policy.js";
export { checkHold } from "./hold-check.js";
