import type { Evidence } from "../contracts/balance.js";
import type { ProjectId, WalletAddress } from "../contracts/ids.js";
import { type BalanceValue, HeliusBalanceReader, FallbackBalanceReader } from "./rpc-reader.js";
import { meetsThreshold, validAddress } from "./token-policy.js";

type Observation = Extract<Evidence<BalanceValue>, { kind: "confirmed" }>;
export type TokenBalance = BalanceValue & {
  readonly projectId: ProjectId;
  readonly owner: WalletAddress;
  readonly mint: WalletAddress;
  readonly checkRound: string;
  readonly thresholdRaw: bigint;
  readonly meetsThreshold: boolean;
  readonly observations: readonly Observation[];
};
export type BalanceConsensusInput = {
  projectId: ProjectId; owner: WalletAddress; mint: WalletAddress; thresholdRaw: bigint;
  /** Stable scheduler/job UUID, reused on retries; not regenerated per provider. */
  checkRound: string;
  primary: HeliusBalanceReader; fallback: FallbackBalanceReader;
};

/** Evidence only. This never changes a binding, membership, or proof status. */
export async function readBalanceConsensus(input: BalanceConsensusInput, mode: "new-grant" | "existing-access"): Promise<Evidence<TokenBalance>> {
  const { primary, fallback } = input;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isHeliusHost = (host: string) => /(^|\.)(helius-rpc\.com|helius\.xyz|helius\.dev)$/.test(host);
  // The mint is whatever the caller configured for this tenant. Pinning a
  // specific mainnet mint is the caller's configuration rule, not a rule here.
  if (!uuid.test(input.projectId) || !uuid.test(input.checkRound) || !validAddress(input.mint) || !validAddress(input.owner) ||
      typeof input.thresholdRaw !== "bigint" || input.thresholdRaw <= 0n ||
      (mode !== "new-grant" && mode !== "existing-access") ||
      primary.provider !== "helius" || fallback.provider !== "fallback" || primary.origin === fallback.origin ||
      primary.hostname === fallback.hostname || isHeliusHost(fallback.hostname)) return { kind: "uncertain", reason: "invalid-response" };
  const request = { owner: input.owner, mint: input.mint, commitment: "finalized" as const };
  const a = await primary.readBalance(request);
  const confirm = (observations: Observation[]): Evidence<TokenBalance> => {
    const first = observations[0]!;
    return {
      kind: "confirmed", provider: observations.length === 2 ? "consensus" : first.provider,
      slot: observations.reduce((min, row) => row.slot < min ? row.slot : min, first.slot),
      observedAt: new Date(Math.min(...observations.map((row) => row.observedAt.getTime()))),
      value: { ...first.value, projectId: input.projectId, owner: input.owner, mint: input.mint,
        checkRound: input.checkRound, thresholdRaw: input.thresholdRaw,
        meetsThreshold: meetsThreshold(first.value.rawAmount, input.thresholdRaw), observations },
    };
  };
  if (mode === "new-grant") {
    if (a.kind === "confirmed" && meetsThreshold(a.value.rawAmount, input.thresholdRaw)) return confirm([a]);
    if (a.kind === "uncertain" && a.reason !== "outage") return { kind: "uncertain", reason: a.reason };
  }
  const b = await fallback.readBalance(request);
  if (mode === "new-grant" && a.kind === "uncertain" && a.reason === "outage" &&
      b.kind === "confirmed" && meetsThreshold(b.value.rawAmount, input.thresholdRaw)) return confirm([b]);
  const uncertain = (reason: "outage" | "conflict" | "stale" | "invalid-response"): Evidence<TokenBalance> => {
    const observations = [a, b].filter((row): row is Observation => row.kind === "confirmed");
    const partial = observations.length > 0 ? confirm(observations) : undefined;
    return { kind: "uncertain", reason,
      ...(partial?.kind === "confirmed" ? { partial: partial.value } : {}),
      failures: [a, b].flatMap((row, index) => row.kind === "uncertain" ? [{ provider: index === 0 ? "helius" as const : "fallback" as const, reason: row.reason }] : []),
    };
  };
  if (a.kind === "uncertain") return uncertain(a.reason);
  if (b.kind === "uncertain") return uncertain(b.reason);
  if (a.value.rawAmount !== b.value.rawAmount || a.value.decimals !== b.value.decimals) return uncertain("conflict");
  return confirm([a, b]);
}
