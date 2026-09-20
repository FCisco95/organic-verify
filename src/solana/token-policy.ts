import bs58 from "bs58";

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Static error codes only: never retain raw provider payloads or endpoint URLs. */
export class RpcFailure extends Error {
  constructor(readonly reason: "outage" | "stale" | "invalid-response", readonly retriable = false) {
    super(reason);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcFailure("invalid-response");
  return value as Record<string, unknown>;
}

export function validAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { const decoded = bs58.decode(value); return decoded.length === 32 && bs58.encode(decoded) === value; }
  catch { return false; }
}

export function validSlot(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RpcFailure("invalid-response");
  return BigInt(value);
}

function validDecimals(value: unknown): number {
  // Mints with more than 18 decimals are outside the supported policy and are
  // reported as uncertainty rather than parsed.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 18) throw new RpcFailure("invalid-response");
  return value;
}

function parsedAccount(value: unknown) {
  const account = record(value);
  const program = account.owner;
  if (account.executable !== false || (program !== SPL_TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM)) throw new RpcFailure("invalid-response");
  const data = record(account.data);
  if (data.program !== (program === SPL_TOKEN_PROGRAM ? "spl-token" : "spl-token-2022")) throw new RpcFailure("invalid-response");
  return { program, parsed: record(data.parsed) };
}

export function parseMint(value: unknown) {
  const response = record(value);
  const slot = validSlot(record(response.context).slot);
  const { program, parsed } = parsedAccount(response.value);
  const info = record(parsed.info);
  if (parsed.type !== "mint" || info.isInitialized !== true) throw new RpcFailure("invalid-response");
  return { slot, program, decimals: validDecimals(info.decimals) };
}

export function parseTokenAccounts(value: unknown, policy: {
  owner: string; mint: string; decimals: number; program: string; minContextSlot: bigint;
}) {
  const response = record(value);
  const slot = validSlot(record(response.context).slot);
  if (slot < policy.minContextSlot) throw new RpcFailure("stale");
  if (!Array.isArray(response.value)) throw new RpcFailure("invalid-response");
  let rawAmount = 0n;
  const seen = new Set<string>();
  for (const item of response.value) {
    const entry = record(item);
    if (!validAddress(entry.pubkey) || seen.has(entry.pubkey)) throw new RpcFailure("invalid-response");
    seen.add(entry.pubkey);
    const { program, parsed } = parsedAccount(entry.account);
    const info = record(parsed.info);
    if (parsed.type !== "account" || program !== policy.program || info.owner !== policy.owner || !validAddress(info.mint) ||
        (info.state !== "initialized" && info.state !== "frozen")) throw new RpcFailure("invalid-response");
    if (info.mint !== policy.mint) continue;
    const amount = record(info.tokenAmount);
    if (validDecimals(amount.decimals) !== policy.decimals || typeof amount.amount !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(amount.amount)) throw new RpcFailure("invalid-response");
    const raw = BigInt(amount.amount);
    if (raw > 18446744073709551615n) throw new RpcFailure("invalid-response");
    rawAmount += raw;
  }
  return { rawAmount, decimals: policy.decimals, slot };
}

export function meetsThreshold(rawAmount: bigint, thresholdRaw: bigint): boolean {
  if (typeof rawAmount !== "bigint" || rawAmount < 0n || typeof thresholdRaw !== "bigint" || thresholdRaw <= 0n) throw new RpcFailure("invalid-response");
  return rawAmount >= thresholdRaw;
}
