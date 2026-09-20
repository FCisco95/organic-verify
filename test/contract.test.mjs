import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";

// The bundle under test can be overridden, for example to run this suite against an installed copy.
const sdk = await import(process.env.VERIFY_SDK_UNDER_TEST ?? "../dist/index.js");
const projectId = "019249a0-0000-7000-8000-0000000000a1";
const requestId = "019249a0-0000-7000-8000-0000000000b2";
const wallet = "11111111111111111111111111111111";
const tenant = { origin: "https://app.example.test:8443", chain: "solana:devnet", productName: "Example", statement: "Prove wallet control." };
const issuedAt = new Date("2026-09-18T12:00:00.000Z");
const fields = { walletAddress: wallet, requestId, nonce: Buffer.alloc(32, 7).toString("base64url"), issuedAt,
  expiresAt: new Date("2026-09-18T12:05:00.000Z"), origin: tenant.origin, chain: tenant.chain };
const expected = `Example wallet verification\n\nDomain: app.example.test:8443\nStatement: Prove wallet control. This does not authorize a transaction or token approval.\nWallet: ${wallet}\nRequest ID: ${requestId}\nNonce: ${fields.nonce}\nIssued At: 2026-09-18T12:00:00.000Z\nExpiration Time: 2026-09-18T12:05:00.000Z\nChain ID: solana:devnet`;
// Public verification-only vector: RFC 8032 section 7.1, TEST 1.
// https://www.rfc-editor.org/rfc/rfc8032#section-7.1
const publicBytes = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const signature = Buffer.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "hex");

test("the exact 21 runtime exports remain compatible", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    "FallbackBalanceReader", "HeliusBalanceReader", "ProviderUnavailable", "WALLET_PROOF_LIFETIME_MS",
    "WalletProofError", "checkHold", "consumeWalletProof", "createVerificationRequest", "decodeNonce",
    "decodeWalletAddress", "formatWalletMessage", "meetsThreshold", "parseProjectId", "parseRawTokenAmount",
    "parseTelegramUserId", "parseThreshold", "parseWalletAddress", "readBalanceConsensus", "validAddress",
    "validateWalletMessage", "verifyWalletSignature",
  ].sort());
});

test("golden bytes, port, exact lifetime, expiry and foreign config", () => {
  assert.equal(sdk.formatWalletMessage(fields, tenant), expected);
  assert.equal(sdk.WALLET_PROOF_LIFETIME_MS, 300000);
  assert.equal(sdk.validateWalletMessage(expected, fields, issuedAt, tenant), true);
  for (const now of [new Date(issuedAt.getTime() - 1), fields.expiresAt, new Date(NaN)]) {
    assert.equal(sdk.validateWalletMessage(expected, fields, now, tenant), false);
  }
  assert.equal(sdk.validateWalletMessage(expected + "\n", fields, issuedAt, tenant), false);
  assert.equal(sdk.validateWalletMessage(expected, fields, issuedAt, { ...tenant, origin: "https://foreign.test" }), false);
  assert.throws(() => sdk.formatWalletMessage({ ...fields, expiresAt: new Date(issuedAt.getTime() + 300001) }, tenant));
});

test("invalid origin and hidden or injected display text are rejected", () => {
  for (const change of [{ origin: "http://app.example.test" }, { origin: tenant.origin + "/" },
    { statement: "Prove control.\nDomain: foreign.test" }, { statement: "Prove\u200bcontrol." },
    { productName: "Example\u202e" }, { productName: " Example" }]) {
    assert.throws(() => sdk.formatWalletMessage({ ...fields, ...change }, { ...tenant, ...change }), /invalid wallet proof/);
  }
});

test("Ed25519 public vector verifies; changed message and small-order points fail", () => {
  assert.equal(sdk.verifyWalletSignature("", signature, bs58.encode(publicBytes)), true);
  assert.equal(sdk.verifyWalletSignature("changed", signature, bs58.encode(publicBytes)), false);
  assert.equal(sdk.verifyWalletSignature("", signature.subarray(0, 63), bs58.encode(publicBytes)), false);
  const identityPoint = Buffer.from("01" + "00".repeat(31), "hex");
  const forged = Buffer.from("58" + "66".repeat(31) + "01" + "00".repeat(31), "hex");
  assert.equal(sdk.verifyWalletSignature("any message", forged, bs58.encode(identityPoint)), false);
});

test("request issuance uses DB time and a tenant/request-bound digest", async () => {
  let saved;
  const store = { databaseNow: async () => issuedAt, insert: async row => { saved = row; } };
  const result = await sdk.createVerificationRequest(store, { projectId, userId: "123" }, wallet, tenant);
  assert.equal(saved.issuedAt, issuedAt);
  assert.equal(saved.expiresAt.getTime() - issuedAt.getTime(), 300000);
  assert.deepEqual(saved.nonceHash, createHash("sha256").update(projectId).update(result.requestId)
    .update(Buffer.from(result.nonce, "base64url")).digest());
  assert.equal(result.message, sdk.formatWalletMessage({ ...saved, nonce: result.nonce }, tenant));
  assert.equal("nonce" in saved, false);
  assert.equal("signature" in saved, false);
});

test("issuance store failures propagate unchanged", async () => {
  const failure = new Error("injected store failure");
  await assert.rejects(sdk.createVerificationRequest({ databaseNow: async () => { throw failure; } },
    { projectId, userId: "123" }, wallet, tenant), error => error === failure);
  await assert.rejects(sdk.createVerificationRequest({ databaseNow: async () => issuedAt, insert: async () => { throw failure; } },
    { projectId, userId: "123" }, wallet, tenant), error => error === failure);
});

test("consumption propagates lookup errors and always clears the input signature", async () => {
  const failure = new Error("injected lookup failure");
  const input = { requestId, nonce: fields.nonce, message: expected, signature: signature.toString("base64url") };
  await assert.rejects(sdk.consumeWalletProof({ findByRequestId: async () => { throw failure; } },
    { projectId, userId: "123" }, input, tenant), error => error === failure);
  assert.equal(input.signature, "");
});

test("proof, plain parser, and reader configuration errors remain distinct", async () => {
  const input = { requestId, nonce: fields.nonce, message: expected, signature: "malformed" };
  await assert.rejects(sdk.consumeWalletProof({}, { projectId, userId: "123" }, input, tenant), sdk.WalletProofError);
  assert.equal(input.signature, "");
  assert.throws(() => sdk.decodeNonce("bad"), error => error instanceof Error && !(error instanceof sdk.WalletProofError));
  assert.throws(() => sdk.parseProjectId("bad"), error => error.name === "ValidationError");
  assert.throws(() => new sdk.HeliusBalanceReader({ rpcUrl: "http://provider.test" }), /Invalid RPC configuration/);
});

const confirmed = (rawAmount, slot = 250n, observedAt = issuedAt) => ({ kind: "confirmed", provider: "fixture",
  value: { rawAmount, decimals: 6 }, slot, observedAt });
const reader = (provider, hostname, evidence) => ({ provider, hostname, origin: `https://${hostname}`, readBalance: async () => evidence });
const hold = (a, b, extra = {}) => sdk.checkHold({ projectId, owner: wallet, mint: wallet, thresholdRaw: 100n, checkRound: requestId,
  primary: reader("helius", "primary.test", a), fallback: reader("fallback", "fallback.test", b), ...extra });

test("hold agrees on both amount and decimals and preserves conservative observation", async () => {
  const early = new Date(issuedAt.getTime() - 1000);
  assert.deepEqual(await hold(confirmed(100n, 300n), confirmed(100n, 250n, early)),
    { kind: "holder", rawAmount: 100n, decimals: 6, provider: "consensus", slot: 250n, observedAt: early });
  assert.equal((await hold(confirmed(99n), confirmed(99n))).kind, "below");
  assert.deepEqual(await hold(confirmed(100n), confirmed(0n)), { kind: "uncertain", reason: "conflict" });
  assert.deepEqual(await hold(confirmed(100n), { ...confirmed(100n), value: { rawAmount: 100n, decimals: 9 } }),
    { kind: "uncertain", reason: "conflict" });
});

for (const reason of ["outage", "stale", "invalid-response", "conflict"]) {
  test(`hold preserves uncertainty: ${reason}`, async () => {
    assert.deepEqual(await hold({ kind: "uncertain", reason }, confirmed(100n)), { kind: "uncertain", reason });
    assert.deepEqual(await hold(confirmed(100n), { kind: "uncertain", reason }), { kind: "uncertain", reason });
  });
}

test("invalid inputs and ineligible readers fail closed", async () => {
  for (const change of [{ thresholdRaw: 0n }, { checkRound: "bad" }, { projectId: "bad" }, { owner: "bad" },
    { fallback: reader("fallback", "primary.test", confirmed(100n)) },
    { fallback: reader("fallback", "devnet.helius-rpc.com", confirmed(100n)) }]) {
    assert.deepEqual(await hold(confirmed(100n), confirmed(100n), change), { kind: "uncertain", reason: "invalid-response" });
  }
});

test("unexpected consumer-reader exceptions propagate, not below", async () => {
  const failure = new Error("injected reader failure");
  await assert.rejects(hold(confirmed(100n), confirmed(100n), { primary: {
    ...reader("helius", "primary.test", confirmed(100n)), readBalance: async () => { throw failure; },
  } }), error => error === failure);
});

test("real RPC reader uses finalized read methods and drops malformed provider detail", async () => {
  const calls = [];
  const program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    const result = request.method === "getAccountInfo"
      ? { context: { slot: 250 }, value: { owner: program, executable: false, data: { program: "spl-token", parsed: { type: "mint", info: { isInitialized: true, decimals: 6 } } } } }
      : request.method === "getTokenAccountsByOwner" ? { context: { slot: 250 }, value: [] }
      : request.method === "getBlockTime" ? issuedAt.getTime() / 1000 : undefined;
    assert.notEqual(result, undefined);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  const rpc = new sdk.HeliusBalanceReader({ rpcUrl: "https://primary.test/?key=redaction-fixture", fetch, now: () => issuedAt.getTime() });
  const result = await rpc.readBalance({ owner: wallet, mint: wallet, commitment: "finalized" });
  assert.equal(result.kind, "confirmed");
  assert.deepEqual(result.value, { rawAmount: 0n, decimals: 6 });
  assert.deepEqual(calls.map(c => c.method), ["getAccountInfo", "getTokenAccountsByOwner", "getBlockTime"]);
  assert.equal(calls[0].params[1].commitment, "finalized");
  assert.equal(calls[1].params[2].commitment, "finalized");
  const bad = new sdk.FallbackBalanceReader({ rpcUrl: "https://fallback.test/?key=redaction-fixture",
    fetch: async () => new Response("redaction-fixture", { status: 403 }) });
  assert.deepEqual(await bad.readBalance({ owner: wallet, mint: wallet, commitment: "finalized" }),
    { kind: "uncertain", reason: "invalid-response" });
});
