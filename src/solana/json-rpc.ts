import { record, RpcFailure } from "./token-policy.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Read-only methods only, enforced at runtime as well as in the type: nothing
 * routed through this transport can construct, sign, or submit anything.
 */
const READ_METHODS = new Set(["getAccountInfo", "getTokenAccountsByOwner", "getBlockTime", "getSlot"] as const);
type ReadMethod = typeof READ_METHODS extends Set<infer T> ? T : never;

/**
 * Only genuine network-level failures are provider outages (retriable and,
 * for a new grant, fallback-eligible). A redirect refused by `redirect:
 * "error"`, an abort, or any unexpected error is not: misconfiguration must
 * never be masked by a single fallback read. Static reasons only; the raw
 * error (whose cause chain can carry the request URL) is dropped here.
 */
function classifyTransportError(error: unknown): RpcFailure {
  if (error instanceof RpcFailure) return error;
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? (error.cause as { code?: unknown }) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (/^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code) && code !== "UND_ERR_ABORTED") return new RpcFailure("outage", true);
  return new RpcFailure("invalid-response");
}

/**
 * The reader owns the deadline across headers, body consumption and retries.
 * `rpcUrl` is the full provider secret (the key travels in the query or the
 * path). Callers must never log it, attach it to an error, or pass it under
 * any other key; only the URL origin is ever safe to expose.
 */
export async function jsonRpc(input: {
  rpcUrl: string; fetch: typeof fetch; signal: AbortSignal; id: number; method: ReadMethod; params: readonly unknown[];
}): Promise<unknown> {
  if (!READ_METHODS.has(input.method)) throw new RpcFailure("invalid-response");
  let response: Response;
  try {
    response = await input.fetch(input.rpcUrl, {
      method: "POST", redirect: "error", signal: input.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: input.id, method: input.method, params: input.params }),
    });
  } catch (error) {
    throw classifyTransportError(error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Only rate limiting and server errors are provider outages. Anything else
    // (401/403 misconfiguration, 4xx rejection) is not fallback-eligible.
    if (response.status === 429 || response.status >= 500) throw new RpcFailure("outage", true);
    throw new RpcFailure("invalid-response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel(); throw new RpcFailure("invalid-response");
  }
  if (!response.body) throw new RpcFailure("invalid-response");
  const reader = response.body.getReader();
  // A body that stalls after headers must be released at the deadline, not
  // held open by a pending read() until the provider closes it.
  const onAbort = () => { reader.cancel().catch(() => undefined); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      input.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new RpcFailure("invalid-response"); }
      chunks.push(next.value);
    }
    input.signal.throwIfAborted();
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
  catch { throw new RpcFailure("invalid-response"); }
  if (payload.jsonrpc !== "2.0" || payload.id !== input.id || ("error" in payload && "result" in payload)) throw new RpcFailure("invalid-response");
  if ("error" in payload) {
    const error = record(payload.error);
    // Node unhealthy: retriable provider outage.
    if (error.code === -32005) throw new RpcFailure("outage", true);
    // Minimum context slot not reached: the provider is behind the finalized
    // slot we already observed. That is stale evidence, not an outage.
    if (error.code === -32016) throw new RpcFailure("stale");
    throw new RpcFailure("invalid-response");
  }
  if (!("result" in payload)) throw new RpcFailure("invalid-response");
  return payload.result;
}
