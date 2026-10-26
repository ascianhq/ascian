# Ascian API

The server behind [Ascian](https://ascian.fun): one balance, funded with crypto, for chat, code, images, video and an OpenAI-compatible API across many AI models.

Node, Express and Postgres. The schema is applied on start (`src/schema.sql`).

## Run it locally

```
npm install
node test/dev.mjs      # API, mock model provider, mock payments and the site on http://localhost:18083
node test/e2e.mjs      # end-to-end checks against a scratch Postgres in DATABASE_URL
node src/server.js     # the API alone
```

The tests start their own server with mocks of the payment processor and the model provider (`mock/`). `SITE_ROOT` points at the static site; by default `../site` in this repository.

## Environment

| Variable | What it is for |
|---|---|
| `DATABASE_URL` | Postgres |
| `ADMIN_TOKEN` | the admin panel at `/api/admin`; without it the panel answers 404 |
| `SITE_URL` | the site address, used in the wallet sign-in message |
| `SOLANA_RPC` | your own RPC, several allowed, comma separated. Without it the public mainnet endpoints are used, both rate limited |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | crypto top-ups |
| `RESEND_API_KEY`, `MAIL_FROM` | sign-in by email code |
| `ANTHROPIC_API_KEY`, `STANDIN_ACCOUNTS`, `STANDIN_MODEL` | test stand-in: with no `PPQ_API_KEY`, chat for the listed accounts (wallet, username or email) is answered by one Anthropic model. Everyone else gets W103; images and video stay off |
| `SIGNUP_CREDITS`, `SIGNUP_DAILY_CAP` | free credits for each new account (0 is off), one per /24 network a day, at most the cap a day across the site |
| `TOKEN_ADDRESS`, `BUY_URL`, `CHART_URL`, ... | fallback only. Launch settings live in the `settings` table and are edited in the admin panel |

## Launch settings without a redeploy

`src/launch.js` keeps launch settings in the `settings` table, one row per key. In the admin panel you paste the mint address; the panel asks the chain whether it is a real mint and shows its decimals, supply, and whether mint and freeze authority are revoked. Save, and the site picks it up without a redeploy. The buy, chart and explorer links are derived from the mint.

## Wallet sign-in

`src/wallet.js`. The message follows Sign In With Solana. The wallet signs the raw message bytes with ed25519, and the address is the public key, so the server verifies the signature against the address directly. Signatures are accepted in base58 (what Phantom returns) or hex. Each challenge carries a nonce, is single use and expires after ten minutes.

## Holdings

A Solana address is base58 and case matters, so addresses are never lowercased. The balance is the sum over all of the owner's token accounts for the mint (`getTokenAccountsByOwner`): a wallet can hold one mint in several accounts, and reading only the first would understate the holding.

## Admin panel lock

`src/admin.js`. Ten wrong tokens from one address in ten minutes return 429. The token is compared first, in constant time, so the right token always gets through and clears the counter; a stranger cannot lock the owner out.
