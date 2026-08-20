import { createPublicClient, createWalletClient, createTestClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
/// True when the demo is talking to a chain someone else is hosting, which changes
/// what we can sensibly tell the visitor if it is unreachable.
export const RPC_IS_LOCAL = /127\.0\.0\.1|localhost/.test(RPC);

const transport = http(RPC);

/// Anvil's deterministic accounts. Account 0 seeded the pool in Deploy.s.sol.
export const victim = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
export const searcher = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
/// Batch lane: someone unwinding MEME on the other side, plus a second buyer.
export const counterparty = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
export const buyerB = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);

export const publicClient = createPublicClient({ chain: foundry, transport });
export const testClient = createTestClient({ chain: foundry, transport, mode: "anvil" });

export const victimClient = createWalletClient({ account: victim, chain: foundry, transport });
export const searcherClient = createWalletClient({ account: searcher, chain: foundry, transport });
export const counterpartyClient = createWalletClient({ account: counterparty, chain: foundry, transport });
export const buyerBClient = createWalletClient({ account: buyerB, chain: foundry, transport });

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
