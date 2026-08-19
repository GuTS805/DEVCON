/**
 * Sends one real trade and reports what came back, so the searcher bot has
 * something to hunt. Run `npm run bot` in another terminal first.
 *
 *   node scripts/victim.mjs exposed   plain swap straight at the pool
 *   node scripts/victim.mjs sealed    commit, wait, then reveal-and-execute
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiOf = (n) =>
  JSON.parse(readFileSync(join(root, "contracts", "out", `${n}.sol`, `${n}.json`), "utf8")).abi;
const addresses = JSON.parse(readFileSync(join(root, "contracts", "deployments", "local.json"), "utf8"));

const ammAbi = abiOf("SimpleAMM");
const erc20Abi = abiOf("MockERC20");
const veilAbi = abiOf("VeilSwap");

const transport = http("http://127.0.0.1:8545");
const publicClient = createPublicClient({ chain: foundry, transport });
const victim = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const wallet = createWalletClient({ account: victim, chain: foundry, transport });

const mode = process.argv[2] ?? "exposed";
const AMOUNT_IN = parseEther("10");
const SLIPPAGE_BPS = BigInt(process.argv[3] ?? "1000");
const MAX = 2n ** 256n - 1n;

const memeBalance = () =>
  publicClient.readContract({
    address: addresses.meme,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [victim.address],
  });

for (const spender of [addresses.amm, addresses.veilSwap]) {
  const hash = await wallet.writeContract({
    address: addresses.weth,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, MAX],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

const fair = await publicClient.readContract({
  address: addresses.amm,
  abi: ammAbi,
  functionName: "quote",
  args: [true, AMOUNT_IN],
});
const minOut = (fair * (10_000n - SLIPPAGE_BPS)) / 10_000n;

console.log(`\nmode        ${mode}`);
console.log(`trading     ${formatEther(AMOUNT_IN)} WETH -> MEME`);
console.log(`fair quote  ${Number(formatEther(fair)).toLocaleString()} MEME`);
console.log(`min out     ${Number(formatEther(minOut)).toLocaleString()} MEME (${SLIPPAGE_BPS} bps)\n`);

const before = await memeBalance();
let reverted = false;

if (mode === "exposed") {
  const hash = await wallet.writeContract({
    address: addresses.amm,
    abi: ammAbi,
    functionName: "swap",
    args: [true, AMOUNT_IN, minOut, victim.address],
  });
  console.log(`sent ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  reverted = receipt.status === "reverted";
} else {
  const salt = keccak256(`0x${Date.now().toString(16)}`);
  const commitId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [victim.address, true, AMOUNT_IN, minOut, salt],
    ),
  );
  const commitHash = await wallet.writeContract({
    address: addresses.veilSwap,
    abi: veilAbi,
    functionName: "commit",
    args: [commitId],
  });
  console.log(`committed ${commitId}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: commitHash });

  const target = receipt.blockNumber + 3n;
  while ((await publicClient.getBlockNumber()) < target) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const revealHash = await wallet.writeContract({
    address: addresses.veilSwap,
    abi: veilAbi,
    functionName: "reveal",
    args: [true, AMOUNT_IN, minOut, salt],
  });
  console.log(`revealed  ${revealHash}`);
  const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
  reverted = revealReceipt.status === "reverted";
}

const received = (await memeBalance()) - before;
const loss = fair - received;

if (reverted) {
  console.log(
    `\n\x1b[32mrefused     the price moved between commit and reveal, so the trade did not execute\x1b[0m`,
  );
  console.log(`            your WETH is untouched — resubmit when the pool settles\n`);
} else {
  console.log(`\nreceived    ${Number(formatEther(received)).toLocaleString()} MEME`);
  if (loss > 0n) {
    console.log(
      `\x1b[31mshortfall   ${Number(formatEther(loss)).toLocaleString()} MEME below the fair quote\x1b[0m\n`,
    );
  } else {
    console.log(`\x1b[32mno loss     filled at the fair quote\x1b[0m\n`);
  }
}
