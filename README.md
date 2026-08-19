# Road to Devcon · NITK Surathkal

Hackathon work for **Road to Devcon — NITK Surathkal**, on the theme *Make Private Apps
using Ethereum*.

## [veilswap/](veilswap/) — Private DeFi & Mempools

The same trade, run three ways against the same live pool: exposed to the public mempool,
sealed behind a commit-reveal, and cleared inside a batch. An autonomous searcher bot
attacks each one so the results are measured rather than asserted.

| | You received | The bot took | The pool saw |
|---|---|---|---|
| Public mempool | 82,816 MEME | 0.9707 WETH | your whole trade |
| VeilSwap | 90,909 MEME | 0 | your whole trade |
| VeilSwap batch | one clearing price | 0 | 4 of 14 WETH |

Foundry + Next.js. Setup, findings and honest limitations are in
[veilswap/README.md](veilswap/README.md).
