import type { ProjectId, WalletAddress } from "./contracts/ids.js";
import { readBalanceConsensus } from "./solana/balance-consensus.js";
import { meetsThreshold } from "./solana/token-policy.js";
import type { FallbackBalanceReader, HeliusBalanceReader } from "./solana/rpc-reader.js";

export type HoldCheckInput = {
  readonly projectId: ProjectId;
  readonly owner: WalletAddress;
  readonly mint: WalletAddress;
  /** Greater than zero. A caller with a zero threshold skips the check entirely. */
  readonly thresholdRaw: bigint;
  /** Stable UUID per logical check, reused on retries; not regenerated per provider. */
  readonly checkRound: string;
  readonly primary: HeliusBalanceReader;
  readonly fallback: FallbackBalanceReader;
};

type Observed = {
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly provider: string;
  readonly slot: bigint;
  readonly observedAt: Date;
};

export type HoldCheckResult =
  | ({ readonly kind: "holder" } & Observed)
  | ({ readonly kind: "below" } & Observed)
  | { readonly kind: "uncertain"; readonly reason: "outage" | "conflict" | "stale" | "invalid-response" };

/**
 * Does this wallet hold at least the threshold, right now?
 *
 * Evidence only. It reads two providers, persists nothing, changes no
 * membership, and grants nothing. "existing-access" mode means both providers
 * must agree: one confirmed reading is not enough to answer "holder", so a
 * single provider returning zero during an incident cannot cost someone their
 * access. Anything short of agreement is `uncertain`, which callers treat as
 * "try again", never as "below".
 *
 * The result carries no provider URL, no API key, no raw response and no
 * observation list — only the numbers a caller needs and which provider name
 * produced them.
 */
export async function checkHold(input: HoldCheckInput): Promise<HoldCheckResult> {
  const evidence = await readBalanceConsensus({
    projectId: input.projectId,
    owner: input.owner,
    mint: input.mint,
    thresholdRaw: input.thresholdRaw,
    checkRound: input.checkRound,
    primary: input.primary,
    fallback: input.fallback,
  }, "existing-access");

  if (evidence.kind === "uncertain") return { kind: "uncertain", reason: evidence.reason };

  const observed: Observed = {
    rawAmount: evidence.value.rawAmount,
    decimals: evidence.value.decimals,
    provider: evidence.provider,
    slot: evidence.slot,
    observedAt: evidence.observedAt,
  };
  return meetsThreshold(evidence.value.rawAmount, input.thresholdRaw)
    ? { kind: "holder", ...observed }
    : { kind: "below", ...observed };
}
