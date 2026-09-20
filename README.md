# @mycel/verify

Replay-proof Solana wallet ownership proofs and two-provider token hold checks,
as run by MYCEL Sentinel.

> **Release status (2026-09-20):** the first release is in progress. Until a
> version of this package appears on the public npm registry with provenance
> that names this repository, its release tag and its publish workflow, treat
> it as unreleased and do not adopt it. A locally packed `0.1.0` tarball is a
> candidate, not installable provenance. No completed Hyphae integration is
> verified.

Two problems this solves, both of which are easy to get subtly wrong:

1. **Proving someone controls a wallet** without a transaction, in a way that a
   captured signature cannot be replayed against you later or against a
   different site.
2. **Deciding whether that wallet still holds enough of a token**, when RPC
   providers disagree, go down, or return a stale slot.

```bash
# Run only after the release checks in "Version and provenance" pass.
npm install @mycel/verify
```

Node 22 or newer. ESM only. The public types use Node's `Buffer`, so a
TypeScript consumer also needs `@types/node`.

## What it will never do

No key or seed handling. No signing. No transaction or approval construction.
The only wallet capability it touches is verifying a detached Ed25519 signature
over readable text, and the message it asks a wallet to sign says so in its own
body. If a change would add any of that, it does not belong in this package.

## Wallet ownership proof

A proof is bound to your origin, a chain, one wallet, one Telegram user, a
single-use 32-byte nonce, and a five-minute window. Reusing a proof fails, and
so does presenting one issued for a different site.

```ts
import { createVerificationRequest, consumeWalletProof, type TenantProofConfig } from "@mycel/verify";

const proofConfig: TenantProofConfig = {
  origin: "https://app.example.com",   // https, no path, query, fragment or credentials
  chain: "solana:mainnet",
  productName: "Example",              // 1-40 characters, one line
  statement: "Prove control of this public wallet for member access.",  // 1-200
};

// 1. Issue a challenge. `store` is yours; see "The store" below.
const { requestId, nonce, message } = await createVerificationRequest(
  store, { projectId, userId: telegramUserId }, walletAddress, proofConfig);

// 2. The browser asks the wallet to sign `message` (wallet-standard signMessage).

// 3. Spend the challenge. Invalid proofs reject; see "Errors are a boundary".
await consumeWalletProof(store, { projectId, userId: telegramUserId },
  { requestId, nonce, message, signature }, proofConfig);
```

The rendered message looks like this, exactly — LF separators, no trailing
newline, millisecond UTC timestamps:

```
Example wallet verification

Domain: app.example.com
Statement: Prove control of this public wallet for member access. This does not authorize a transaction or token approval.
Wallet: <base58 address>
Request ID: <uuid>
Nonce: <base64url, 32 bytes>
Issued At: 2026-09-18T12:00:00.000Z
Expiration Time: 2026-09-18T12:05:00.000Z
Chain ID: solana:mainnet
```

The final sentence of the `Statement:` line is appended by this library. You
cannot remove or reword it, and a member can be taught to look for it. For the
same reason `productName` and `statement` reject control characters, line
breaks, zero-width marks and bidirectional formatting characters: anything that
could add a line, hide one, or reverse the text a person is reading. They are
rejected, never trimmed or repaired.

### The store

`createVerificationRequest` and `consumeWalletProof` take a `VerificationStore`
you implement over your own tables. This package holds no database, and it
never sees your connection. The store interface does not pass `projectId` to
its methods, so construct a new adapter bound to the server-authenticated
tenant. Every query and mutation must include that tenant scope; never select a
tenant from the request body or mutate a shared store's tenant between calls.

`databaseNow()` must read the database clock. `insert()` stores the tenant,
user, wallet, nonce digest, origin, chain, issue time, expiry and pending state.
`findByRequestId()` is tenant-scoped; another tenant's ID resolves as absent.

`verifySignature()` is the final transaction boundary. Lock the request first,
then conditionally update the **exact row snapshot** the SDK verified: tenant,
request ID, pending status, user, wallet, nonce digest, issue time, expiry,
origin and chain. Recheck `issued_at <= clock_timestamp()` and
`expires_at > clock_timestamp()` after the lock wait, and enforce the exact
five-minute lifetime. Return true only if exactly one complete transaction
commits. A read-then-write or an application-host expiry check cannot make a
proof single-use.

For a link flow, bind the authenticated link-session ID into the adapter too.
The same `verifySignature()` transaction must consume the proof, link the
member wallet, and mark exactly one session used. Acquire scoped request/session
locks consistently and judge final expiry by DB wall time after their waits,
including any later blocking member operation. Known transaction failures roll
back all three. Return true only after confirmed commit; false means known
no-commit. A lost commit acknowledgement is unknown: respond unavailable and
reconcile durable tenant/session/request state before reporting success or
retrying effects. No partial link or duplicated consumption/notification is valid.

`WalletProofIdentity` must be derived from an already authenticated server-side
session. A link token and request body are untrusted inputs. The browser may
submit proof fields, but it may not choose the tenant, Telegram user, origin or
chain. The successful SDK result means only `signature_verified`; it is not
holder evidence, admission, or permission to create or score a contribution.

## Lower-level exports, and how to get them wrong

`validateWalletMessage`, `verifyWalletSignature` and `readBalanceConsensus` are
exported because they are useful when you are building something this package
does not cover. They are not a verification flow, and using them as one gets you
a system that looks like it checks proofs and does not.

**`validateWalletMessage(message, fields, now, config)`** compares a message
against what `formatWalletMessage` would render for `fields`. If you take
`fields` from the message the user just submitted, the comparison is a tautology
and always passes. `now` must come from the same clock that decides expiry — the
database's, not the web host's. And on its own it consumes no nonce, so the same
captured signature keeps verifying until its own `expiresAt`, which the
submitter also chose.

**`verifyWalletSignature`** answers only "is this signature valid for these
bytes and this key". It says nothing about whether the message was one you
issued, whether it has expired, or whether it has already been used.

Together they are the inside of `consumeWalletProof`, which adds the parts that
make a proof single-use: the stored request, the nonce digest, the database
clock, and the conditional update. **Use `consumeWalletProof`.**

**`readBalanceConsensus(input, mode)`** takes a mode, and the two values are not
interchangeable:

- `"existing-access"` — both providers must agree. This is what `checkHold`
  uses, and what you want whenever a negative answer costs someone something.
- `"new-grant"` — a single confirmed provider above the threshold is enough.
  Correct when granting access, because the worst case is one grant too many.
  **Using it to decide a removal turns one provider's bad reading into a real
  removal.**

If you are deciding whether someone still qualifies, call `checkHold`.

For Hyphae's new-submission hold gate, call `checkHold` as well. Its stricter
two-provider result is the consumer contract; do not substitute the lower-level
`"new-grant"` mode.

## Token hold check

```ts
import { checkHold, HeliusBalanceReader, FallbackBalanceReader } from "@mycel/verify";

const result = await checkHold({
  projectId, owner: walletAddress, mint, thresholdRaw: 1_000_000n,
  checkRound,                                    // stable UUID, reused on retries
  primary: new HeliusBalanceReader({ rpcUrl: process.env.HELIUS_RPC_URL! }),
  fallback: new FallbackBalanceReader({ rpcUrl: process.env.FALLBACK_RPC_URL! }),
});

switch (result.kind) {
  case "holder": break;                          // rawAmount, decimals, provider, slot, observedAt
  case "below": break;                           // same fields; under the threshold
  case "uncertain": break;                       // reason: outage | conflict | stale | invalid-response
}
```

Both providers must agree on amount and decimals. One confirmed reading is not
enough to answer `holder`, so a single provider returning zero during an
incident cannot cost someone their access. The two RPC URLs must be HTTPS on
different hosts, and the fallback must not be a Helius host, or the check is
`uncertain` by design.

Apply the result before capture, scoring, reward reservation or spending:

- `holder`: continue to the next normally authorized submission step. This is
  evidence, not a grant by itself.
- `below`: refuse or defer the new submission without creating, scoring,
  reserving or spending. For existing access it is evidence only; it never
  bypasses an approved grace/recheck/removal policy.
- `uncertain`: defer the new submission without creating, scoring, reserving or
  spending, invite a retry, and preserve all existing access. Never coerce it
  to `below` or cache it.

A consumer cache must bind evidence to community, wallet, mint, chain,
threshold/policy version and freshness policy. Preserve original observation
time and invalidate keyed changes, wallet relinks and relevant network/provider
changes; hits cannot renew evidence. The SDK supplies no cache or chain
attestation. Operators establish the intended network and independent providers.

Package-produced hold results do not contain an RPC URL, API key, raw provider
body or observation list. Consumer-thrown errors are outside that guarantee and
must be sanitized at the consumer boundary.

## Errors are a boundary

The public API has a mixed error contract. Many proof mismatches throw
`WalletProofError("invalid wallet proof")`, while malformed formatting can
throw plain `Error`, exported parsers can throw a non-exported validation
error, invalid reader configuration throws plain `Error`, and every store
exception propagates unchanged. `checkHold` maps expected provider/consensus
failures to `uncertain`, but an unexpected consumer/runtime failure can still
reject.

Map all proof/validation failures to fixed user text such as `Link failed.
Start again with /link.` Map store or unexpected failures to a separate fixed
unavailable response. Log only an allowlisted reason code and correlation ID.
Never return or log an arbitrary error message, cause, stack, database query,
RPC URL, link token, nonce, message or signature. The SDK clears the mutable
`input.signature` value during proof consumption; do not use it afterward.

## Consumer acceptance gate

A production consumer must prove its own boundary. At minimum, test:

- server-derived tenant/user identity; cross-user, cross-tenant, wrong-config,
  expired and used-session attempts;
- concurrent valid proof submissions with exactly one winner, replay refusal,
  exact-snapshot mismatch, and expiry while waiting for a row lock;
- rollback of proof/member/session on final-write or known commit-abort failure,
  using the real DB adapter; lost-acknowledgement reconciliation without
  duplicated linking, consumption or external effects;
- competing proofs sharing a session, session expiry during lock waits and
  final validity after later blocking member operations;
- fixed sanitized responses/logs for `WalletProofError`, plain validation
  errors and injected store failures;
- `holder`, `below` and every `uncertain` reason, missing/invalid RPC config,
  provider non-independence, and cache freshness/invalidation. `uncertain`
  defers new work without scoring/spending and preserves existing access.

## Version and provenance

Pin an exact registry version (`"@mycel/verify": "0.1.0"`) and commit the
consumer lockfile. Do not adopt from a range, dist-tag, workspace link, Git URL,
local tarball or unpublished branch.

This repository is the public source and build route for the package. Every
file under `src/` is an exported copy of a reviewed MYCEL Sentinel source at a
recorded hash, and releases are published only by the tag-driven GitHub
Actions workflow in this repository with npm provenance.

Before adoption, verify that the package exists in the public registry; its
integrity matches the lockfile/tarball; npm provenance names the expected
repository, release tag, commit and GitHub Actions workflow; and the tag,
manifest version and reviewed source agree. Install that exact registry version
in a clean consumer outside this monorepo on supported Node versions and check
that its runtime/types resolve with no `workspace:*` or private-scope runtime
dependency. The release tag must resolve to the reviewed commit, and the provenance
statement must name `FCisco95/mycel-verify`.

Until all of those checks and the consumer acceptance suite pass, the package
and Hyphae adoption remain unverified.

## Development

```bash
npm ci --ignore-scripts
npm run verify   # build, strict typecheck, contract tests; no live providers
```

## License

MIT, see [LICENSE](./LICENSE). Exported from MYCEL Sentinel, whose own
repository is private; this repository is the public source of the package.
