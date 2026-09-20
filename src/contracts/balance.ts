import type { WalletAddress } from "./ids.js";

export type Evidence<T> =
  | { readonly kind: "confirmed"; readonly value: T; readonly provider: string; readonly slot: bigint; readonly observedAt: Date }
  | { readonly kind: "uncertain"; readonly reason: "outage" | "conflict" | "stale" | "invalid-response";
      /**
       * Describes which round was inconclusive so it can be marked as such.
       * Never persisted as a confirmed observation and never sufficient to
       * grant or remove: the round is recorded only as uncertainty markers.
       */
      readonly partial?: T;
      readonly failures?: readonly { provider: "helius" | "fallback"; reason: "outage" | "conflict" | "stale" | "invalid-response" }[];
    };

export interface BalanceReader {
  readBalance(input: { owner: WalletAddress; mint: WalletAddress; commitment: "finalized" }): Promise<Evidence<{ rawAmount: bigint; decimals: number }>>;
}
