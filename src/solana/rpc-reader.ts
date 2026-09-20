import type { BalanceReader, Evidence } from "../contracts/balance.js";
import type { WalletAddress } from "../contracts/ids.js";
import { setTimeout as delay } from "node:timers/promises";
import { jsonRpc } from "./json-rpc.js";
import { parseMint, parseTokenAccounts, RpcFailure, validAddress, validSlot } from "./token-policy.js";

export type BalanceValue = { rawAmount: bigint; decimals: number };
export type ReadBalanceInput = { owner: WalletAddress; mint: WalletAddress; commitment: "finalized" };
export type MintInfo = { mintAddress: WalletAddress; decimals: number };
/** `rpcUrl` is the full provider secret (key in query or path); only `origin` is ever observable afterwards. */
export type ReaderOptions = { rpcUrl: string; fetch?: typeof fetch; now?: () => number };

/**
 * A provider could not answer a discovery request. The message is exactly the
 * fixed reason; no cause, body, origin, endpoint, or provider text is attached,
 * so the error may cross into any route or log unchanged.
 */
export class ProviderUnavailable extends Error {
  constructor(readonly reason: "outage" | "stale" | "invalid-response") {
    super(reason);
    // Non-enumerable, like `message`: the only own enumerable key is `reason`.
    Object.defineProperty(this, "name", { value: "ProviderUnavailable", enumerable: false, configurable: true, writable: true });
  }
}

type ReadMethod = Parameters<typeof jsonRpc>[0]["method"];
type Call = (method: ReadMethod, params: readonly unknown[]) => Promise<unknown>;

/** Configuration is supplied by the operator, never an HTTP request. No default endpoint. */
class RpcBalanceReader implements BalanceReader {
  readonly origin: string;
  readonly hostname: string;
  #rpcUrl: string;
  #fetch: typeof fetch;
  #now: () => number;
  #active = 0;

  constructor(readonly provider: "helius" | "fallback", options: ReaderOptions) {
    let url: URL;
    try { url = new URL(options.rpcUrl); }
    catch { throw new Error("Invalid RPC configuration"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid RPC configuration");
    this.origin = url.origin;
    this.hostname = url.hostname.replace(/\.$/, "");
    this.#rpcUrl = url.toString();
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async readBalance(input: ReadBalanceInput): Promise<Evidence<BalanceValue>> {
    // The mint is whatever the caller configured for this tenant. Pinning a
    // specific mainnet mint is the caller's configuration rule, not a
    // provider-boundary rule.
    if (input.commitment !== "finalized" || !validAddress(input.mint) || !validAddress(input.owner)) return { kind: "uncertain", reason: "invalid-response" };
    try {
      return await this.#bounded((call) => this.#read(input, call));
    } catch (error) {
      return { kind: "uncertain", reason: error instanceof RpcFailure ? error.reason : "outage" };
    }
  }

  /** Finalized slot as a bigint. Rejects only with `RpcFailure` carrying a fixed reason; the caller judges degradation. */
  async readFinalizedSlot(): Promise<bigint> {
    try {
      return await this.#bounded(async (call) => validSlot(await call("getSlot", [{ commitment: "finalized" }])));
    } catch (error) {
      // A body-stream failure can escape the transport raw; never let it out.
      throw error instanceof RpcFailure ? error : new RpcFailure("outage");
    }
  }

  /** Address and decimals of an SPL Token / Token-2022 mint. Rejects with `ProviderUnavailable` only. */
  async discoverMint(mint: WalletAddress): Promise<MintInfo> {
    if (!validAddress(mint)) throw new ProviderUnavailable("invalid-response");
    let decimals: number;
    try {
      decimals = await this.#bounded(async (call) =>
        parseMint(await call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }])).decimals);
    } catch (error) {
      // Translate to the fixed reason and drop the raw failure entirely.
      throw new ProviderUnavailable(error instanceof RpcFailure ? error.reason : "outage");
    }
    return { mintAddress: mint, decimals };
  }

  /**
   * One four-second deadline, one concurrency slot, and at most two attempts
   * shared by every read. Rejects with `RpcFailure` carrying a static reason.
   */
  async #bounded<T>(read: (call: Call) => Promise<T>): Promise<T> {
    // No waiting queue: callers under load get uncertainty and preserve access.
    if (this.#active >= 8) throw new RpcFailure("outage");
    this.#active++;
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RpcFailure("outage")); }, 4000);
    });
    let id = 0;
    const call: Call = (method, params) => {
      signal.throwIfAborted();
      return jsonRpc({ rpcUrl: this.#rpcUrl, fetch: this.#fetch, signal, id: ++id, method, params });
    };
    const attempts = async (): Promise<T> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await read(call);
        } catch (error) {
          if (signal.aborted || attempt === 1 || (error instanceof RpcFailure && !error.retriable)) throw error;
          await delay(100 + Math.floor(Math.random() * 151), undefined, { signal });
        }
      }
      throw new RpcFailure("outage");
    };
    try {
      return await Promise.race([attempts(), deadline]);
    } finally {
      clearTimeout(timer); controller.abort(); this.#active--;
    }
  }

  async #read(input: ReadBalanceInput, call: Call): Promise<Evidence<BalanceValue>> {
    const mint = parseMint(await call("getAccountInfo", [input.mint, { encoding: "jsonParsed", commitment: "finalized" }]));
    const balance = parseTokenAccounts(await call("getTokenAccountsByOwner", [input.owner, { mint: input.mint }, {
      encoding: "jsonParsed", commitment: "finalized", minContextSlot: Number(mint.slot),
    }]), { owner: input.owner, mint: input.mint, decimals: mint.decimals, program: mint.program, minContextSlot: mint.slot });
    // A provider's own getSlot can be stale too. Check the age of the actual
    // finalized account context against wall time (120s age, 30s future skew).
    const blockTime = await call("getBlockTime", [Number(balance.slot)]);
    const now = this.#now();
    if (typeof blockTime !== "number" || !Number.isSafeInteger(blockTime) || !Number.isFinite(now) ||
        now - blockTime * 1000 > 120_000 || blockTime * 1000 - now > 30_000) throw new RpcFailure("stale");
    return { kind: "confirmed", value: { rawAmount: balance.rawAmount, decimals: balance.decimals },
      provider: this.provider, slot: balance.slot, observedAt: new Date(now) };
  }
}

export class HeliusBalanceReader extends RpcBalanceReader {
  constructor(options: ReaderOptions) { super("helius", options); }
}
export class FallbackBalanceReader extends RpcBalanceReader {
  constructor(options: ReaderOptions) { super("fallback", options); }
}
