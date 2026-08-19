/**
 * An autonomous searcher.
 *
 * Nothing here is scripted against the demo. The bot polls Anvil's pending
 * transaction pool, decodes whatever it finds, and decides for itself whether
 * there is a trade worth bracketing. Point it at the chain, then drive the UI:
 * whatever it manages to do to you, it worked out on its own.
 *
 * Anvil orders a block's transactions by fee, so a front-run submitted at a
 * higher gas price lands ahead of the victim in the very same block.
 *
 *   node scripts/searcher-bot.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  formatEther,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiOf = (name) =>
  JSON.parse(readFileSync(join(root, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8")).abi;

const addresses = JSON.parse(
  readFileSync(join(root, "contracts", "deployments", "local.json"), "utf8"),
);

const ammAbi = abiOf("SimpleAMM");
const erc20Abi = abiOf("MockERC20");
const veilAbi = abiOf("VeilSwap");
const batchAbi = abiOf("BatchVeilSwap");

const AMM = addresses.amm.toLowerCase();
const VEIL = addresses.veilSwap.toLowerCase();
const BATCH = addresses.batchVeilSwap.toLowerCase();

const transport = http("http://127.0.0.1:8545");
const publicClient = createPublicClient({ chain: foundry, transport });

// Anvil account 2 — the same searcher the UI attributes trades to.
const searcher = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const wallet = createWalletClient({ account: searcher, chain: foundry, transport });

const MIN_TARGET = parseEther("1");
const FRONTRUN_SIZE = parseEther("5");
const MAX = 2n ** 256n - 1n;

const seen = new Set();
/** Hashes of our own transactions, so the bot never brackets itself. */
const ours = new Set();
let holding = 0n;
let busy = false;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = (tag, msg) => console.log(`${c.dim(new Date().toISOString().slice(11, 19))} ${tag} ${msg}`);

async function approveOnce() {
  for (const token of [addresses.weth, addresses.meme]) {
    const hash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [addresses.amm, MAX],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

/** Read the pool's own view of a trade so the bot can size its attack. */
const quote = (wethIn, amountIn) =>
  publicClient.readContract({ address: addresses.amm, abi: ammAbi, functionName: "quote", args: [wethIn, amountIn] });

/**
 * Work out what a pending transaction is actually asking the chain to do.
 * Returns null when the calldata carries nothing the bot can act on.
 */
function readIntent(tx) {
  const to = tx.to?.toLowerCase();
  if (!to) return null;

  if (to === AMM) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: ammAbi, data: tx.input });
      if (functionName !== "swap") return null;
      return { kind: "amm swap", wethIn: args[0], amountIn: args[1], minOut: args[2] };
    } catch {
      return null;
    }
  }

  // The commit carries a hash and nothing else, but the reveal has to spell the
  // order out in calldata. If that is readable here, it is readable to anyone.
  if (to === VEIL) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: veilAbi, data: tx.input });
      if (functionName === "commit") return { kind: "sealed commit" };
      if (functionName === "reveal") {
        return { kind: "veil reveal", wethIn: args[0], amountIn: args[1], minOut: args[2] };
      }
      return null;
    } catch {
      return null;
    }
  }

  if (to === BATCH) {
    try {
      const { functionName } = decodeFunctionData({ abi: batchAbi, data: tx.input });
      if (functionName === "commit") return { kind: "sealed commit" };
      if (functionName === "reveal") return { kind: "batch reveal" };
      if (functionName === "settleBatch") return { kind: "batch settle" };
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

async function sandwich(target, victimTx) {
  busy = true;
  // txpool_content hands back hex strings, not bigints.
  const victimGas = BigInt(victimTx.gasPrice ?? victimTx.maxFeePerGas ?? "0x3b9aca00");
  const gasPrice = victimGas * 3n;

  try {
    const wethBefore = await publicClient.readContract({
      address: addresses.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [searcher.address],
    });
    const memeBefore = await publicClient.readContract({
      address: addresses.meme,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [searcher.address],
    });

    const frontHash = await wallet.writeContract({
      address: addresses.amm,
      abi: ammAbi,
      functionName: "swap",
      args: [true, FRONTRUN_SIZE, 0n, searcher.address],
      gasPrice,
    });
    ours.add(frontHash.toLowerCase());
    log(c.red("FRONT-RUN"), `buying with ${formatEther(FRONTRUN_SIZE)} WETH at ${gasPrice} wei gas`);

    await publicClient.waitForTransactionReceipt({ hash: frontHash });
    const memeAfter = await publicClient.readContract({
      address: addresses.meme,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [searcher.address],
    });
    holding = memeAfter - memeBefore;

    // Let the victim's transaction land before unwinding.
    await publicClient.waitForTransactionReceipt({ hash: victimTx.hash }).catch(() => {});

    const backHash = await wallet.writeContract({
      address: addresses.amm,
      abi: ammAbi,
      functionName: "swap",
      args: [false, holding, 0n, searcher.address],
    });
    ours.add(backHash.toLowerCase());
    await publicClient.waitForTransactionReceipt({ hash: backHash });

    const wethAfter = await publicClient.readContract({
      address: addresses.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [searcher.address],
    });
    const profit = wethAfter - wethBefore;

    if (profit > 0n) {
      log(c.red("PROFIT"), c.red(`+${formatEther(profit)} WETH taken from ${target.kind}`));
    } else {
      log(c.green("LOSS"), c.green(`${formatEther(profit)} WETH — the attack did not pay`));
    }
  } catch (err) {
    log(c.yellow("ABORTED"), `${err.shortMessage ?? err.message}`);
  } finally {
    holding = 0n;
    busy = false;
  }
}

async function tick() {
  let pool;
  try {
    pool = await publicClient.request({ method: "txpool_content" });
  } catch {
    return;
  }

  const pending = Object.values(pool.pending ?? {}).flatMap((byNonce) => Object.values(byNonce));

  for (const tx of pending) {
    const hash = tx.hash?.toLowerCase();
    if (!hash || seen.has(hash) || ours.has(hash)) continue;
    seen.add(hash);

    if (tx.from?.toLowerCase() === searcher.address.toLowerCase()) continue;

    const intent = readIntent(tx);
    if (!intent) continue;

    if (intent.kind === "sealed commit") {
      log(c.cyan("SEEN"), "a sealed commit — hash only, no size or direction. Nothing to act on.");
      continue;
    }

    if (intent.kind === "batch reveal") {
      log(c.cyan("SEEN"), "a batch reveal — it queues an order, it does not trade. Skipping.");
      continue;
    }

    if (intent.kind === "batch settle") {
      log(c.cyan("SEEN"), "a batch settlement — orders already matched off-pool. Skipping.");
      continue;
    }

    // An AMM swap or a VeilSwap reveal both spell the order out in calldata.
    if (!intent.wethIn || intent.amountIn < MIN_TARGET) continue;
    if (busy) {
      log(c.yellow("BUSY"), `ignoring a second target while unwinding`);
      continue;
    }

    const fair = await quote(true, intent.amountIn);
    const room = fair - intent.minOut;
    log(
      c.yellow("TARGET"),
      `${intent.kind}: ${formatEther(intent.amountIn)} WETH in, min out ${formatEther(intent.minOut)} ` +
        `(${formatEther(room)} MEME of slippage room)`,
    );

    if (room <= 0n) {
      log(c.green("PASS"), c.green("no slippage room — a sandwich would revert the victim. Leaving it."));
      continue;
    }

    await sandwich(intent, tx);
  }
}

console.log(`
${c.cyan("searcher bot")} — watching 127.0.0.1:8545
  AMM        ${addresses.amm}
  VeilSwap   ${addresses.veilSwap}
  Batch      ${addresses.batchVeilSwap}
  as         ${searcher.address}

Polling the pending pool. Drive the UI and see what it finds.
`);

await approveOnce();
setInterval(() => {
  tick().catch((e) => log(c.yellow("ERR"), e.shortMessage ?? e.message));
}, 120);
