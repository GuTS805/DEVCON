// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {VeilSwap} from "../src/VeilSwap.sol";
import {BatchVeilSwap} from "../src/BatchVeilSwap.sol";

/// @dev Deploys the demo pool and funds the anvil default accounts.
///      Account 0 = liquidity provider, account 1 = victim, account 2 = searcher.
contract Deploy is Script {
    uint256 constant POOL_WETH = 100 ether;
    uint256 constant POOL_MEME = 1_000_000 ether;

    address constant VICTIM = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant SEARCHER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    /// Batch demo needs a counterparty on the other side and a second buyer.
    address constant COUNTERPARTY = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address constant BUYER_B = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH");
        MockERC20 meme = new MockERC20("Meme Token", "MEME");
        SimpleAMM amm = new SimpleAMM(weth, meme);
        VeilSwap veil = new VeilSwap(amm, 3, 50, 100);
        BatchVeilSwap batch = new BatchVeilSwap(amm, 3, 50);

        weth.mint(deployer, POOL_WETH);
        meme.mint(deployer, POOL_MEME);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(POOL_WETH, POOL_MEME);

        weth.mint(VICTIM, 1000 ether);
        weth.mint(SEARCHER, 1000 ether);
        meme.mint(SEARCHER, 100_000 ether);
        meme.mint(COUNTERPARTY, 1_000_000 ether);
        weth.mint(BUYER_B, 1000 ether);

        vm.stopBroadcast();

        string memory json = "deployment";
        vm.serializeAddress(json, "weth", address(weth));
        vm.serializeAddress(json, "meme", address(meme));
        vm.serializeAddress(json, "amm", address(amm));
        vm.serializeAddress(json, "veilSwap", address(veil));
        string memory out = vm.serializeAddress(json, "batchVeilSwap", address(batch));
        vm.writeJson(out, "./deployments/local.json");

        console.log("WETH          ", address(weth));
        console.log("MEME          ", address(meme));
        console.log("SimpleAMM     ", address(amm));
        console.log("VeilSwap      ", address(veil));
        console.log("BatchVeilSwap ", address(batch));
    }
}
