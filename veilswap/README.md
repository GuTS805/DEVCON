# VeilSwap

### ▶ Live demo: **[veilswap.vercel.app](https://veilswap.vercel.app)**

Press the three buttons in order and watch the numbers below diverge. Nothing is
pre-recorded — each run executes against a real chain and reads the result back.

---

The same 10 WETH trade, run three ways against the same live pool. Once through the
public mempool, where a searcher bot reads it and brackets it. Once sealed behind a
commit-reveal, where the bot has nothing to read. Once inside a batch, where most of the
trade never reaches the pool at all.

Built for **Road to Devcon · NITK Surathkal** — track: *Private DeFi & Mempools*.

| | You received | The bot took | The pool saw |
|---|---|---|---|
| Public mempool | 82,816 MEME | 0.9707 WETH | your whole trade |
| VeilSwap | 90,909 MEME | 0 | your whole trade |
| VeilSwap batch | one clearing price | 0 | 4 of 14 WETH |

Those numbers are not hardcoded. They come out of Solidity on a local chain, and the
sandwich reproduces the Session 1 lab to the wei.

They are also not self-reported. `scripts/searcher-bot.mjs` is an independent process
that polls the pending pool, decodes what it finds and decides for itself what to attack.
Left running against the exposed path it takes **0.970654627539503385 WETH** — the Session
1 figure, to the last wei, arrived at on its own.

## The problem

An Ethereum swap sits in the public mempool before it is mined, carrying its size,
direction and slippage tolerance in plain calldata. A searcher reads it and:

1. **Front-runs** — buys the same token first, pushing the price against you.
2. **Lets you fill** — your trade still succeeds, because the damage stays inside your
   slippage tolerance.
3. **Back-runs** — sells into the pool you just moved, pocketing the difference.

You are the filling. The bot is the bread on both sides.

## The fix

`VeilSwap.sol` puts a commit-reveal in front of the pool:

1. `commit(bytes32)` — publish only `keccak256(trader, direction, amountIn, minOut, salt)`.
   A watcher learns that *an* order exists, not what it is.
2. Wait `revealDelay` blocks.
3. `reveal(direction, amountIn, minOut, salt)` — the contract checks the preimage and
   performs the swap **in the same transaction**.

The parameters become public only once the swap has already settled, so there is no
window in which a searcher knows the trade and can still act on it.

## What the bot found, and what it changed

Building the searcher as a real, independent process broke the first version of this
project — which is the reason it exists.

The commit is genuinely opaque; the bot logs `a sealed commit — hash only, no size or
direction`. But `reveal(bool, uint256, uint256, bytes32)` has to spell the order out in
calldata, and that transaction sits in the mempool like any other. The bot read it,
front-ran the reveal itself, and took **0.6977 WETH** — nearly as much as from the
unprotected path.

Hiding the order until reveal is not enough. The reveal has to be safe to publish.

**The fix.** `commit()` now records the pool's spot price, and `reveal()` refuses to
execute if the price has moved more than `maxDriftBps` (1%) since then. An attacker who
shifts the pool far enough to be worth attacking makes the reveal revert, which strands
the front-run with no victim to sell into. Run the bot against it now and it reports:

```
SEEN       a sealed commit — hash only, no size or direction. Nothing to act on.
TARGET     veil reveal: 10 WETH in, min out 81818.18 (9090.90 MEME of slippage room)
FRONT-RUN  buying with 5 WETH at 3600000024 wei gas
LOSS       -0.000000000000000001 WETH — the attack did not pay
```

The trader's swap does not go through either — it reverts and their WETH is untouched, to
be resubmitted once the pool settles. Refusing to trade beats being robbed, but it is a
refusal, not a fill, and `test_frontRunningTheRevealMakesItRevert` pins that behaviour.

**What this leaves open.** A griefer who does not care about profit can keep reverting
someone's reveals by nudging the price. The bound trades a theft vector for a
denial-of-service one. Narrowing the reveal window, or routing reveals through a private
relay, is where this goes next.

## The second gap: batch clearing

Commit-reveal removes the front-run, but the settled swap is still on chain at full size,
tagged with your address. Any indexer reads it after the fact.

`BatchVeilSwap.sol` closes that. Orders revealed into the same batch are matched against
each other first, at the spot price recorded at settlement, and only the leftover
imbalance is swapped against the pool:

- Two buyers submit 10 and 4 WETH. A seller unwinds 10 WETH worth of MEME.
- 10 WETH of that flow finds a counterparty inside the batch and never touches the AMM.
- The pool — and every indexer watching it — sees a 4 WETH swap. **71% of the order flow
  produces no on-chain trade at all.**
- Everyone on the same side clears at one identical price, so there is no ordering
  advantage inside the batch either.

`test_offsettingOrdersNeverTouchThePool` asserts the strong version of this: when the
batch nets to zero, the AMM emits **no `Swap` event whatsoever**.

### The batch had the same disease

Settlement is permissionless, and the first version read the pool's spot price *at
settlement* to decide how much of the batch matched internally. So whoever called
`settleBatch` could move the pool and settle in one transaction, choosing the rate their
own order cleared at. `SettlementAttacker` in `test/BatchManipulation.t.sol` does exactly
that — a participant with a sell order in the batch shoves the price, settles, and unwinds:

```
attacker WETH, honest settle   110.000
attacker WETH, rigged settle   112.964     +2.965 WETH
buyer MEME,    honest settle   100,000
buyer MEME,    rigged settle    69,444     -30,555 MEME
```

The honest buyer lost 30% of their fill to someone who did nothing but call a public
function at the right moment.

The fix is the same shape as the reveal fix: the batch records the pool price when its
**first order is revealed**, matches at that anchored price, and refuses to settle if the
pool has drifted more than 1% since. Moving the price no longer changes the match, and the
drift bound stops the leftover swap filling at a rigged rate. The rigged settle now
reverts, while `test_smallDriftStillSettles` keeps ordinary movement working.

## What this does not fix

Worth saying out loud, because a demo that overclaims is worse than one that doesn't:

- A validator can still censor or delay a reveal.
- The commit leaks that some order is coming, and the salt-free fields are low entropy,
  which is why the salt is required.
- Batching hides order flow from the *pool*, but the reveal transactions themselves are
  still public — an observer sees who joined the batch, just not the executed prices or
  sizes of the matched portion.
- Settlement is permissionless but not yet incentivised; a production version needs to
  pay whoever calls `settleBatch`. Right now a batch can sit unsettled until someone
  bothers.
- Both drift bounds are a fixed 1% against a single spot reading. A real deployment wants
  a TWAP, so that a pool which is genuinely volatile does not become unusable.

It removes the front-run, and it keeps most of the flow off the AMM's public trade log.
Session 2's zero-knowledge material is the path to hiding the rest.

## Running it

Needs [Foundry](https://book.getfoundry.sh/getting-started/installation) and Node 18+.

```bash
npm run setup     # install web dependencies

npm run chain     # terminal 1 — anvil with 2s blocks, so the mempool is real
npm run deploy    # terminal 2 — deploy the pool, sync ABIs into the frontend
npm run web       # terminal 3 — http://localhost:3000
```

Then press **Run it exposed**, **Run it sealed**, and **Run it as a batch**. Each run
rolls the chain back to the same pool state first, so every path is compared on identical
reserves.

### Running it hosted

A public testnet cannot host this demo. It needs instant blocks, four funded signers and
`evm_revert` to put the pool back between runs — so the hosted version is the same Anvil
chain behind a URL, not a different chain. Nothing on it holds value; the keys are Anvil's
published test accounts and the state is wiped on every restart.

**The chain.** `chain/Dockerfile` boots Anvil and deploys the contracts into it on start.
Its paths are relative to the repository root, and `railway.json` at the root already
points at it, so a Docker host needs no configuration beyond connecting the repo. Leave
the root directory unset — pointing it at `veilswap/` hides the root `railway.json` and
the host falls back to guessing.

| setting | value |
|---|---|
| root directory | leave empty |
| dockerfile | `veilswap/chain/Dockerfile` (already set in `railway.json`) |
| port | taken from `$PORT`, falls back to 8545 |

**The frontend.** Deploy `veilswap/web` to any Next.js host and set one variable:

```
NEXT_PUBLIC_RPC_URL=https://your-chain-host.example.com
```

It has to be `https://` — a page served over HTTPS cannot call an HTTP endpoint, the
browser blocks it as mixed content.

Because a fresh Anvil always deploys to the same addresses,
`web/src/generated/contracts.ts` is committed and needs no regeneration at build time.

One caveat worth knowing: each run calls `evm_revert`, which rewinds the chain for
*everyone* connected. Two people clicking at the same moment will interfere with each
other. Pressing **Reset pool** puts it right.

### Turning the real searcher loose

The UI scripts its own attacker so the comparison is reproducible. To watch an
independent one work instead, run the bot in a fourth terminal and feed it trades from the
command line:

```bash
npm run bot                      # polls the pending pool, decides for itself

node scripts/victim.mjs exposed  # a plain swap — expect to be sandwiched
node scripts/victim.mjs sealed   # commit-reveal — expect the attack to fail
```

The bot is not told what to look for. It decodes pending calldata, works out how much
slippage room an order leaves, and only attacks when the arithmetic says it pays.

Two things to know when running it:

- **Stop the bot before using the UI.** The web demo rewinds the chain between runs with
  `evm_revert`, which pulls the ground out from under anything else watching the chain.
  Run the bot with the CLI victim, or the UI on its own — not both.
- **Redeploy for the headline numbers.** Anvil keeps its state, so a pool that has already
  been traded against gives different (still real) figures. `npm run deploy` puts the
  reserves back to 100 WETH / 1,000,000 MEME, which is where 82,816 and 90,909 come from.

```bash
npm test          # the sandwich and the defence, as Foundry tests
```

## Layout

```
contracts/
  src/SimpleAMM.sol       constant-product pool, no fee — the unprotected path
  src/VeilSwap.sol        commit-reveal router in front of it
  src/BatchVeilSwap.sol   commit-reveal + internal matching, one clearing price
  src/MockERC20.sol       WETH / MEME for the demo pool
  test/Sandwich.t.sol     proves the attack, the defence, and the front-run of the reveal
  test/Batch.t.sol        proves offsetting flow never reaches the pool
  test/BatchManipulation.t.sol  attacks settlement itself, and shows the anchor holding
  script/Deploy.s.sol     seeds 100 WETH / 1,000,000 MEME and funds the actors
web/
  src/lib/demo.ts         drives each run against the chain, streams beats to the UI
  src/app/page.tsx        the lane comparison and the batch section
scripts/
  searcher-bot.mjs        autonomous searcher — polls the pool, picks its own targets
  victim.mjs              sends one real trade for the bot to hunt
  sync-abi.mjs            copies ABIs + deployed addresses into the frontend
```

## Notes

- The frontend signs with Anvil's deterministic accounts rather than a browser wallet, so
  the demo is one click and cannot fail on a wallet prompt mid-presentation.
- Runs are isolated with `anvil_snapshot` / `evm_revert`, not by redeploying.
- `SimpleAMM` charges no fee. That is deliberate: it keeps the arithmetic identical to the
  Session 1 lab so the numbers are checkable against the slides.
