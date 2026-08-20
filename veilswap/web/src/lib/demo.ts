import { encodeAbiParameters, keccak256, parseEther, formatEther, type Hex } from "viem";
import { addresses, ammAbi, batchVeilSwapAbi, erc20Abi, veilSwapAbi } from "@/generated/contracts";
import {
  buyerB,
  buyerBClient,
  counterparty,
  counterpartyClient,
  publicClient,
  searcher,
  searcherClient,
  testClient,
  victim,
  victimClient,
} from "./chain";

const AMM = addresses.amm as Hex;
const VEIL = addresses.veilSwap as Hex;
const BATCH = addresses.batchVeilSwap as Hex;
const WETH = addresses.weth as Hex;
const MEME = addresses.meme as Hex;
const MAX = 2n ** 256n - 1n;

export const VICTIM_IN = parseEther("10");
export const SEARCHER_IN = parseEther("5");
const SLIPPAGE_BPS = 1000n;
/// Must match the revealDelay VeilSwap was deployed with.
const REVEAL_DELAY = 3;

export type Beat = {
  id: string;
  actor: "victim" | "searcher" | "pool";
  /// Overrides the actor badge when a beat belongs to someone else in the batch.
  who?: string;
  /// Pool price (MEME per WETH) once this step has executed. Plotted on the tape,
  /// which is where the sandwich becomes visible as a dip rather than a sentence.
  price?: bigint;
  /// Marks the step where the trader's own order actually filled.
  fill?: boolean;
  /// Which of the four shared moments this belongs to. Both paths are pinned to the
  /// same four, so they can be read across rather than as two separate logs.
  moment?: 1 | 2 | 3 | 4;
  title: string;
  detail?: string;
  block?: number;
  sealed?: boolean;
  hash?: Hex;
  tone: "attack" | "victim" | "quiet";
  targeted?: boolean;
};

export type RunResult = {
  fairOut: bigint;
  victimOut: bigint;
  victimLoss: bigint;
  searcherProfit: bigint;
  /// Batch lane only: order flow submitted vs the part the pool actually saw.
  hidden?: { submitted: bigint; observed: bigint };
};

export type RunEvent = { type: "beat"; beat: Beat } | { type: "result"; result: RunResult };

let snapshotId: Hex | null = null;

const memeBalance = (who: Hex) =>
  publicClient.readContract({ address: MEME, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const wethBalance = (who: Hex) =>
  publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/// Pool price in MEME per WETH. Read after each step so the tape can plot it.
const spot = () =>
  publicClient.readContract({ address: AMM, abi: ammAbi, functionName: "spotPrice" });

const quote = (wethIn: boolean, amountIn: bigint) =>
  publicClient.readContract({ address: AMM, abi: ammAbi, functionName: "quote", args: [wethIn, amountIn] });

/// Each account signs its own approvals in order — parallel sends from one account
/// collide on the nonce.
async function approveAll() {
  const perAccount = [
    [
      () => victimClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [AMM, MAX] }),
      () => victimClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [VEIL, MAX] }),
      () => victimClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [BATCH, MAX] }),
    ],
    [
      () => searcherClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [AMM, MAX] }),
      () => searcherClient.writeContract({ address: MEME, abi: erc20Abi, functionName: "approve", args: [AMM, MAX] }),
    ],
    [
      () =>
        counterpartyClient.writeContract({
          address: MEME,
          abi: erc20Abi,
          functionName: "approve",
          args: [BATCH, MAX],
        }),
    ],
    [
      () =>
        buyerBClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [BATCH, MAX] }),
    ],
  ];

  await Promise.all(
    perAccount.map(async (queue) => {
      for (const send of queue) {
        const hash = await send();
        await publicClient.waitForTransactionReceipt({ hash });
      }
    }),
  );
}

/// Approves once, then pins pool state so every run starts from the same book.
export async function initDemo() {
  if (snapshotId) return;
  await approveAll();
  snapshotId = await testClient.snapshot();
}

/// Rolls the chain back to the pinned pool state.
export async function resetPool() {
  if (!snapshotId) return initDemo();
  await testClient.revert({ id: snapshotId });
  snapshotId = await testClient.snapshot();
}

const minOut = (fair: bigint) => (fair * (10_000n - SLIPPAGE_BPS)) / 10_000n;

async function send(promise: Promise<Hex>) {
  const hash = await promise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A reverted transaction still yields a receipt. Without this the lane would
  // quietly report a zero payout instead of the failure that caused it.
  if (receipt.status === "reverted") {
    throw new Error(`transaction reverted: ${hash}`);
  }
  return { hash, block: Number(receipt.blockNumber) };
}

export async function* runExposed(): AsyncGenerator<RunEvent> {
  const fairOut = await quote(true, VICTIM_IN);
  const limit = minOut(fairOut);

  yield {
    type: "beat",
    beat: {
      id: "intent",
      actor: "victim",
      title: "Your swap enters the public mempool",
      detail: `10 WETH → MEME · expecting ${fmt(fairOut)} MEME · 10% slippage`,
      tone: "victim",
      targeted: true,
      price: await spot(),
      moment: 1,
    },
  };

  const searcherWethBefore = await wethBalance(searcher.address);

  const frontrun = await send(
    searcherClient.writeContract({
      address: AMM,
      abi: ammAbi,
      functionName: "swap",
      args: [true, SEARCHER_IN, 0n, searcher.address],
    }),
  );
  const searcherMeme = (await memeBalance(searcher.address)) - parseEther("100000");
  yield {
    type: "beat",
    beat: {
      id: "frontrun",
      actor: "searcher",
      title: "Bot buys ahead of you",
      detail: `5 WETH → ${fmt(searcherMeme)} MEME · price now worse for you`,
      block: frontrun.block,
      hash: frontrun.hash,
      tone: "attack",
      price: await spot(),
      moment: 2,
    },
  };

  const victimMemeBefore = await memeBalance(victim.address);
  const swap = await send(
    victimClient.writeContract({
      address: AMM,
      abi: ammAbi,
      functionName: "swap",
      args: [true, VICTIM_IN, limit, victim.address],
    }),
  );
  const victimOut = (await memeBalance(victim.address)) - victimMemeBefore;
  yield {
    type: "beat",
    beat: {
      id: "victim",
      actor: "victim",
      title: "Your swap settles at the worse price",
      detail: `10 WETH → ${fmt(victimOut)} MEME · inside your slippage, so it succeeds`,
      block: swap.block,
      hash: swap.hash,
      tone: "victim",
      price: await spot(),
      fill: true,
      moment: 3,
    },
  };

  const backrun = await send(
    searcherClient.writeContract({
      address: AMM,
      abi: ammAbi,
      functionName: "swap",
      args: [false, searcherMeme, 0n, searcher.address],
    }),
  );
  const searcherProfit = (await wethBalance(searcher.address)) - searcherWethBefore;
  yield {
    type: "beat",
    beat: {
      id: "backrun",
      actor: "searcher",
      title: "Bot sells back and books the spread",
      detail: `${fmt(searcherMeme)} MEME → WETH · profit ${formatEther(searcherProfit)} WETH`,
      block: backrun.block,
      hash: backrun.hash,
      tone: "attack",
      price: await spot(),
      moment: 4,
    },
  };

  yield {
    type: "result",
    result: { fairOut, victimOut, victimLoss: fairOut - victimOut, searcherProfit },
  };
}

export async function* runSealed(): AsyncGenerator<RunEvent> {
  const fairOut = await quote(true, VICTIM_IN);
  const limit = minOut(fairOut);
  const salt = keccak256(`0x${Date.now().toString(16)}` as Hex);

  const commitId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [victim.address, true, VICTIM_IN, limit, salt],
    ),
  );

  const commit = await send(
    victimClient.writeContract({ address: VEIL, abi: veilSwapAbi, functionName: "commit", args: [commitId] }),
  );
  yield {
    type: "beat",
    beat: {
      id: "commit",
      actor: "victim",
      title: "You publish a sealed order",
      detail: `10 WETH → MEME · expecting ${fmt(fairOut)} MEME · 10% slippage`,
      block: commit.block,
      hash: commitId,
      sealed: true,
      tone: "victim",
      price: await spot(),
      moment: 1,
    },
  };

  yield {
    type: "beat",
    beat: {
      id: "watch",
      actor: "searcher",
      title: "Bot reads the mempool and finds a hash",
      detail: "No size, no direction, nothing to bracket. It sits this one out.",
      tone: "quiet",
      moment: 2,
    },
  };

  const target = commit.block + REVEAL_DELAY;
  for (;;) {
    const now = Number(await publicClient.getBlockNumber());
    const remaining = target - now;
    if (remaining <= 0) break;
    yield {
      type: "beat",
      beat: {
        id: "waiting",
        actor: "pool",
        title: `Sealed for ${remaining} more block${remaining === 1 ? "" : "s"}`,
        detail: "The order stays unreadable until the reveal window opens.",
        block: now,
        tone: "quiet",
        moment: 2,
      },
    };
    await new Promise((r) => setTimeout(r, 500));
  }

  yield {
    type: "beat",
    beat: {
      id: "waiting",
      actor: "pool",
      title: "Reveal window open",
      detail: "The order can now be opened, and only by the trader who sealed it.",
      block: target,
      tone: "quiet",
      moment: 2,
    },
  };

  const victimMemeBefore = await memeBalance(victim.address);
  const reveal = await send(
    victimClient.writeContract({
      address: VEIL,
      abi: veilSwapAbi,
      functionName: "reveal",
      args: [true, VICTIM_IN, limit, salt],
    }),
  );
  const victimOut = (await memeBalance(victim.address)) - victimMemeBefore;
  yield {
    type: "beat",
    beat: {
      id: "reveal",
      actor: "victim",
      title: "Reveal and execute in one transaction",
      detail: `10 WETH → ${fmt(victimOut)} MEME · public only after it settled`,
      block: reveal.block,
      hash: reveal.hash,
      tone: "victim",
      price: await spot(),
      fill: true,
      moment: 3,
    },
  };

  // Closes the fourth moment so the two paths line up row for row. There is no
  // transaction here, which is exactly the point.
  yield {
    type: "beat",
    beat: {
      id: "nothing-after",
      actor: "searcher",
      title: "Nothing to sell back",
      detail: "The bot never took a position, so there is no spread to book.",
      tone: "quiet",
      price: await spot(),
      moment: 4,
    },
  };

  yield {
    type: "result",
    result: { fairOut, victimOut, victimLoss: fairOut - victimOut, searcherProfit: 0n },
  };
}

const BUYER_A_IN = parseEther("10");
const BUYER_B_IN = parseEther("4");
/// The seller offsets exactly this much of the buy side. Sized from the live spot
/// price at run time so the batch matches the same amount whatever the reserves are.
const SELLER_OFFSETS = parseEther("10");

type Participant = {
  who: string;
  title: string;
  address: Hex;
  client: typeof victimClient;
  wethIn: boolean;
  amountIn: bigint;
  salt: Hex;
};

/// Three sealed orders settle as one batch. Offsetting flow is matched inside the
/// batch and never reaches the pool, so an indexer sees only the remainder.
export async function* runBatch(): AsyncGenerator<RunEvent> {
  const stamp = Date.now().toString(16);
  const spot = await publicClient.readContract({
    address: AMM,
    abi: ammAbi,
    functionName: "spotPrice",
  });
  const sellerIn = (SELLER_OFFSETS * spot) / 10n ** 18n;
  const people: Participant[] = [
    {
      who: "You",
      title: "You seal an order",
      address: victim.address,
      client: victimClient,
      wethIn: true,
      amountIn: BUYER_A_IN,
      salt: keccak256(`0x${stamp}01` as Hex),
    },
    {
      who: "Second buyer",
      title: "Another buyer seals one too",
      address: buyerB.address,
      client: buyerBClient,
      wethIn: true,
      amountIn: BUYER_B_IN,
      salt: keccak256(`0x${stamp}02` as Hex),
    },
    {
      who: "Seller unwinding",
      title: "Someone seals the opposite trade",
      address: counterparty.address,
      client: counterpartyClient,
      wethIn: false,
      amountIn: sellerIn,
      salt: keccak256(`0x${stamp}03` as Hex),
    },
  ];

  let lastCommitBlock = 0;
  for (const p of people) {
    const commitId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [p.address, p.wethIn, p.amountIn, 0n, p.salt],
      ),
    );
    const sent = await send(
      p.client.writeContract({ address: BATCH, abi: batchVeilSwapAbi, functionName: "commit", args: [commitId] }),
    );
    lastCommitBlock = Math.max(lastCommitBlock, sent.block);
    yield {
      type: "beat",
      beat: {
        id: `commit-${p.who}`,
        actor: "victim",
        who: p.who,
        title: p.title,
        detail: p.wethIn
          ? `${fmt(p.amountIn, 0)} WETH → MEME`
          : `${fmt(p.amountIn)} MEME → WETH`,
        block: sent.block,
        hash: commitId,
        sealed: true,
        tone: "victim",
      },
    };
  }

  const target = lastCommitBlock + REVEAL_DELAY;
  for (;;) {
    const now = Number(await publicClient.getBlockNumber());
    const remaining = target - now;
    if (remaining <= 0) break;
    yield {
      type: "beat",
      beat: {
        id: "waiting",
        actor: "pool",
        who: "Batch",
        title: `Sealed for ${remaining} more block${remaining === 1 ? "" : "s"}`,
        detail: "Three orders are queued. None of them is readable yet.",
        block: now,
        tone: "quiet",
      },
    };
    await new Promise((r) => setTimeout(r, 500));
  }

  yield {
    type: "beat",
    beat: {
      id: "waiting",
      actor: "pool",
      who: "Batch",
      title: "Reveal window open",
      detail: "All three orders can now be opened into the batch.",
      block: target,
      tone: "quiet",
    },
  };

  for (const p of people) {
    await send(
      p.client.writeContract({
        address: BATCH,
        abi: batchVeilSwapAbi,
        functionName: "reveal",
        args: [p.wethIn, p.amountIn, 0n, p.salt],
      }),
    );
  }

  yield {
    type: "beat",
    beat: {
      id: "revealed",
      actor: "pool",
      who: "Batch",
      title: "All three reveal into the same batch",
      detail: "Revealing queues an order. It does not trade yet, so there is still nothing to bracket.",
      block: Number(await publicClient.getBlockNumber()),
      tone: "quiet",
    },
  };

  const memeBefore = await memeBalance(victim.address);
  const reserveWethBefore = await publicClient.readContract({
    address: AMM,
    abi: ammAbi,
    functionName: "reserveWeth",
  });

  const settle = await send(
    counterpartyClient.writeContract({ address: BATCH, abi: batchVeilSwapAbi, functionName: "settleBatch" }),
  );

  const reserveWethAfter = await publicClient.readContract({
    address: AMM,
    abi: ammAbi,
    functionName: "reserveWeth",
  });
  const victimOut = (await memeBalance(victim.address)) - memeBefore;
  const poolSaw = reserveWethAfter - reserveWethBefore;
  const totalBuySide = BUYER_A_IN + BUYER_B_IN;

  yield {
    type: "beat",
    beat: {
      id: "settled",
      actor: "pool",
      who: "Batch",
      title: "Batch clears at one price",
      detail: `${fmt(totalBuySide, 0)} WETH of buying was submitted, but the pool only ever saw ${fmt(poolSaw, 0)} WETH. The rest was matched inside the batch.`,
      block: settle.block,
      hash: settle.hash,
      tone: "victim",
    },
  };

  yield {
    type: "result",
    result: {
      fairOut: victimOut,
      victimOut,
      victimLoss: 0n,
      searcherProfit: 0n,
      hidden: { submitted: totalBuySide, observed: poolSaw },
    },
  };
}

export function fmt(wei: bigint, digits = 0) {
  return Number(formatEther(wei)).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
