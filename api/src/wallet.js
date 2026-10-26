// Wallet signatures on Solana: one curve, no hashing.
//
// Phantom and Solflare sign the raw bytes of a message with ed25519 and the public key is the
// address, so there is nothing to recover and nothing to prefix. The EVM path this replaced
// recovered a secp256k1 key from a keccak hash of an "\x19Ethereum Signed Message" envelope.
import { ed25519 } from "@noble/curves/ed25519";
import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { rand } from "./util.js";
import { isMint, base58decode, token as liveToken, splBalance } from "./launch.js";

// A wallet address and a mint are the same shape: 32 bytes, base58.
export const isAddr = a => isMint(a);

// Signatures arrive base58 (what Phantom hands back) or as hex, and both are accepted because
// a wallet that hands back hex is not worth a support ticket.
function sigBytes(signature) {
  const s = String(signature || "").trim();
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(s)) {
    const h = s.replace(/^0x/, "");
    return Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  }
  return base58decode(s);
}

// Plain text, close to EIP-4361 so it reads the same way in the wallet dialog. Only this
// server reads it back; the browser treats it as opaque.
export async function challenge(address, purpose, accountId = null) {
  const nonce = rand(12), host = new URL(cfg.siteUrl).host, now = new Date(), exp = new Date(Date.now() + 10 * 60e3);
  const statement = purpose === "link"
    ? `Link this wallet to your ${cfg.brand} account. Nothing moves and nothing is spent.`
    : `Sign in to ${cfg.brand}. Nothing moves and nothing is spent.`;
  const message = `${host} wants you to sign in with your Solana account:\n${address}\n\n${statement}\n\nURI: ${cfg.siteUrl}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${exp.toISOString()}`;
  await q("insert into wallet_challenges (nonce,address,purpose,account_id,message,expires_at) values ($1,$2,$3,$4,$5,$6)",
    [nonce, address, purpose, accountId, message, exp]);
  return message;
}

// Returns the verified address or throws a sentence for the UI.
export async function verify(message, signature, purpose, accountId = null) {
  const nonce = (String(message).match(/\nNonce: ([0-9a-f]+)\n/) || [])[1];
  if (!nonce) throw new Error("That sign-in message is not one of ours.");
  const ch = await one("update wallet_challenges set used=true where nonce=$1 and not used and expires_at>now() returning *", [nonce]);
  if (!ch || ch.message !== message || ch.purpose !== purpose || (accountId && String(ch.account_id) !== String(accountId)))
    throw new Error("That sign-in message has expired. Try again.");
  let good = false;
  try {
    good = ed25519.verify(sigBytes(signature), new TextEncoder().encode(message), base58decode(ch.address));
  } catch { good = false; }
  if (!good) throw new Error("The signature was refused.");
  return ch.address;
}

// The holding, summed over every token account the owner has for the mint.
export async function tokenBalance(address) {
  const mint = await liveToken();
  if (!mint) return null;
  try { return await splBalance(address, mint); }
  catch { throw new Error("read_failed"); }
}
