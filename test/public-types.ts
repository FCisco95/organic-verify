import type {
  ProjectId, TelegramUserId, WalletAddress, Evidence, BalanceReader,
  TenantProofConfig, WalletMessageFields, WalletProofIdentity,
  WalletProofSubmission, VerificationStore, TokenBalance,
  BalanceConsensusInput, HoldCheckInput, HoldCheckResult,
} from "../dist/index.js";

// Compiled against the built declarations, not the source entrypoint.
export type PublicSurface = [
  ProjectId, TelegramUserId, WalletAddress, Evidence<unknown>, BalanceReader,
  TenantProofConfig, WalletMessageFields, WalletProofIdentity,
  WalletProofSubmission, VerificationStore, TokenBalance,
  BalanceConsensusInput, HoldCheckInput, HoldCheckResult,
];
