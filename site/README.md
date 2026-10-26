# Ascian site

The static site of [Ascian](https://ascian.fun): every AI model on one balance, funded with crypto.

A static Next.js export, hosted on Vercel. `vercel.json` sends `/api`, `/v1` and `/r` to the API server (`../api` in the same repository).

A small runtime layer sits on top of the export:

- `site.js` reads the launch settings from `/api/site-config` and fills in token links.
- `solana.js` connects Phantom, Solflare or Backpack: wallet sign-in and wallet linking sign a Sign In With Solana message, and the holding panel reads the ASCIAN balance once the mint is set.
- `motion.js`, `motion.css` hold the page motion and small UI illustrations.
- `hero/` is the home page scene: three.js r180 (MIT) on a layout from the Fromzero template (Unlicense).
- `cli/ascian.mjs` is a one-file command-line client for the API.

To run it locally, serve the folder with any static server, or run `node test/dev.mjs` in `../api`, which serves this site together with the API and mocks.
