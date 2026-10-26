# Ascian

Every AI model on one balance, funded with crypto. Chat, code, images, video and an OpenAI-compatible API, paid per request from credits you top up with the crypto in your wallet. No subscription, no card.

- Site: https://ascian.fun
- X: https://x.com/useascian
- Contact: hello@ascian.fun

## What is here

- [`site/`](site): the website. A static Next.js export on Vercel with a small runtime layer: Solana wallet sign-in (Phantom, Solflare, Backpack), the holder panel, motion, and the home page scene (three.js).
- [`api/`](api): the server. Node, Express and Postgres: accounts, the credit ledger, crypto top-ups, the model gateway, the OpenAI-compatible `/v1`, and the admin panel used on launch day.

## Run it locally

```
cd api
npm install
node test/dev.mjs      # API, mock model provider, mock payments and the site on http://localhost:18083
```

`test/dev.mjs` needs a local Postgres (see `api/README.md`). It serves `../site` together with the API, so the whole product runs on one machine without real keys.

## Token

$ASCIAN on Solana. Holding it lowers the platform fee and unlocks perks; it is never a yield or a revenue share. Details on the site's token page.
