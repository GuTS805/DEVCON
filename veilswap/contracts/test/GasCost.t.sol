// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {VeilSwap} from "../src/VeilSwap.sol";
import {BatchVeilSwap} from "../src/BatchVeilSwap.sol";

/// Neither defence is free. A commit-reveal is two transactions where a swap was one,
/// and a batch adds a settlement on top. Printing the numbers is more useful than
/// leaving a judge to guess at them.
contract GasCostTest is Test {
    MockERC20 weth;
    MockERC20 meme;
    SimpleAMM amm;
    VeilSwap veil;
    BatchVeilSwap batch;

    address lp = address(0xA11CE);
    address trader = address(0xB0B);
    address buyerB = address(0xB2);
    address seller = address(0x51);

    uint256 constant IN = 10 ether;

    struct Costs {
        uint256 unprotected;
        uint256 commit;
        uint256 reveal;
        uint256 batchCommit;
        uint256 batchReveal;
        uint256 settle;
    }

    Costs c;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        meme = new MockERC20("Meme Token", "MEME");
        amm = new SimpleAMM(weth, meme);
        veil = new VeilSwap(amm, 2, 50, 100);
        batch = new BatchVeilSwap(amm, 2, 50, 100);

        weth.mint(lp, 100 ether);
        meme.mint(lp, 1_000_000 ether);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(100 ether, 1_000_000 ether);
        vm.stopPrank();

        address[3] memory who = [trader, buyerB, seller];
        for (uint256 i = 0; i < 3; i++) {
            weth.mint(who[i], 100 ether);
            meme.mint(who[i], 500_000 ether);
            vm.startPrank(who[i]);
            weth.approve(address(amm), type(uint256).max);
            weth.approve(address(veil), type(uint256).max);
            weth.approve(address(batch), type(uint256).max);
            meme.approve(address(batch), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _measureUnprotected() internal {
        vm.prank(trader);
        uint256 g = gasleft();
        amm.swap(true, IN, 0, trader);
        c.unprotected = g - gasleft();
    }

    function _measureVeil() internal {
        bytes32 salt = keccak256("gas");
        bytes32 id = veil.hashOrder(trader, true, IN, 0, salt);

        vm.prank(trader);
        uint256 g = gasleft();
        veil.commit(id);
        c.commit = g - gasleft();

        vm.roll(block.number + 2);

        vm.prank(trader);
        g = gasleft();
        veil.reveal(true, IN, 0, salt);
        c.reveal = g - gasleft();
    }

    function _measureBatch() internal {
        bytes32[3] memory salts = [bytes32("b1"), bytes32("b2"), bytes32("b3")];
        address[3] memory who = [trader, buyerB, seller];
        bool[3] memory wethIn = [true, true, false];
        uint256[3] memory amounts = [IN, 4 ether, 100_000 ether];
        uint256 g;

        for (uint256 i = 0; i < 3; i++) {
            bytes32 id = batch.hashOrder(who[i], wethIn[i], amounts[i], 0, salts[i]);
            vm.prank(who[i]);
            g = gasleft();
            batch.commit(id);
            if (i == 0) c.batchCommit = g - gasleft();
        }

        vm.roll(block.number + 2);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(who[i]);
            g = gasleft();
            batch.reveal(wethIn[i], amounts[i], 0, salts[i]);
            if (i == 0) c.batchReveal = g - gasleft();
        }

        g = gasleft();
        batch.settleBatch();
        c.settle = g - gasleft();
    }

    function test_whatEachRouteCosts() public {
        _measureUnprotected();
        _measureVeil();
        _measureBatch();

        uint256 veilTotal = c.commit + c.reveal;
        // Settlement is one transaction for the whole batch, so each trader carries
        // only their share of it.
        uint256 batchTotal = c.batchCommit + c.batchReveal + c.settle / 3;

        console.log("unprotected swap         ", c.unprotected);
        console.log("veilswap commit          ", c.commit);
        console.log("veilswap reveal+execute  ", c.reveal);
        console.log("veilswap total           ", veilTotal);
        console.log("batch commit             ", c.batchCommit);
        console.log("batch reveal             ", c.batchReveal);
        console.log("batch settle (3 orders)  ", c.settle);
        console.log("batch per trader         ", batchTotal);
        console.log("veilswap as % of plain   ", (veilTotal * 100) / c.unprotected);
        console.log("batch    as % of plain   ", (batchTotal * 100) / c.unprotected);

        // Tripwires set above what these actually cost today, so a change that makes
        // either defence dramatically dearer fails loudly. They are not targets — the
        // measured figures are roughly 1.9x and 3.6x a plain swap, and batching being
        // the most expensive route is the honest trade for what it hides.
        assertLt(veilTotal, (c.unprotected * 25) / 10, "commit-reveal got much dearer");
        assertLt(batchTotal, (c.unprotected * 45) / 10, "batching got much dearer");
    }
}
