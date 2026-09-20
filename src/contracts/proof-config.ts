import { ValidationError } from "./errors.js";
import { asRecord, rejectUnknownKeys, requireSingleLine, requireString } from "./validation.js";

/**
 * The tenant-visible half of a wallet ownership proof: the four values that
 * appear in the signed message. It is a committed, non-secret manifest — a
 * domain, a chain, and two lines of display text — so it can live in the
 * repository and be reviewed like any other change.
 *
 * The message asserts control of a public key and nothing else. The sentence
 * disclaiming transaction and approval authority is appended by the formatter
 * itself and is not a value a tenant can supply, remove or reword.
 */
export interface TenantProofConfig {
  /** An `https:` origin with no path, query, fragment or credentials. */
  readonly origin: string;
  readonly chain: ProofChain;
  readonly productName: string;
  readonly statement: string;
}

const PROOF_CHAINS = ["solana:mainnet", "solana:devnet"] as const;
/**
 * Narrower than `SolanaChain`. A proof is only ever issued against a chain the
 * balance readers also serve, and testnet is not one of them.
 */
export type ProofChain = (typeof PROOF_CHAINS)[number];

const PROOF_CONFIG_KEYS = ["origin", "chain", "productName", "statement"] as const;
const PRODUCT_NAME_BOUNDS = { min: 1, max: 40 } as const;
const STATEMENT_BOUNDS = { min: 1, max: 200 } as const;

/**
 * Rejects anything that could make one tenant's message readable as another's,
 * or that could smuggle a second line into a signed payload. The returned
 * origin is the serialized origin, so `Domain:` is derived from a value that
 * has already been normalized once.
 */
export function parseProofOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("tenant proof config.origin must be a URL");
  }
  if (url.protocol !== "https:") throw new ValidationError("tenant proof config.origin must use https");
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("tenant proof config.origin must not carry credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ValidationError("tenant proof config.origin must have no path, query or fragment");
  }
  // `new URL("https://host/").origin` drops the trailing slash, so an input
  // that differs from its own origin carried something this check would not
  // otherwise see.
  if (value !== url.origin) throw new ValidationError("tenant proof config.origin must be a bare origin");
  return url.origin;
}

/** Pure validation. It reads no environment, opens no connection, and returns only what the caller declared. */
export function parseTenantProofConfig(value: unknown): TenantProofConfig {
  const label = "tenant proof config";
  const record = asRecord(value, label);
  rejectUnknownKeys(record, PROOF_CONFIG_KEYS, label);

  const origin = parseProofOrigin(requireString(record, "origin", label));

  const chain = requireString(record, "chain", label);
  if (!(PROOF_CHAINS as readonly string[]).includes(chain)) {
    throw new ValidationError(`${label}.chain must be one of ${PROOF_CHAINS.join(", ")}`);
  }

  const productName = requireSingleLine(
    requireString(record, "productName", label), PRODUCT_NAME_BOUNDS, `${label}.productName`);
  const statement = requireSingleLine(
    requireString(record, "statement", label), STATEMENT_BOUNDS, `${label}.statement`);

  return { origin, chain: chain as ProofChain, productName, statement };
}
