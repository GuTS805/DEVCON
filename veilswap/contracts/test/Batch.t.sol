// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {BatchVeilSwap} from "../src/BatchVeilSwap.sol";

contract BatchTest is Test {
    MockERC20 weth;
    MockERC20 meme;
    SimpleAMM amm;
    BatchVeilSwap batch;

    address lp = address(0xA11CE);
    address buyerA = address(0xB0B);
    address buyerB = address(0xB0B2);
    address seller = address(0x5E11);

    uint256 constant POOL_WETH = 100 ether;
    uint256 constant POOL_MEME = 1_000_000 ether;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        meme = new MockERC20("Meme Token", "MEME");
        amm = new SimpleAMM(weth, meme);
        batch = new BatchVeilSwap(amm, 2, 50);

        weth.mint(lp, POOL_WETH);
        meme.mint(lp, POOL_MEME);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(POOL_WETH, POOL_MEME);
        vm.stopPrank();

        weth.mint(buyerA, 100 ether);
        weth.mint(buyerB, 100 ether);
        meme.mint(seller, 500_000 ether);

        vm.prank(buyerA);
        weth.approve(address(batch), type(uint256).max);
        vm.prank(buyerB);
        weth.approve(address(batch), type(uint256).max);
        vm.prank(seller);
        meme.approve(address(batch), type(uint256).max);
    }

    function _submit(address trader, bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt) internal {
        // Resolve the hash before pranking — vm.prank only covers the next call.
        bytes32 commitId = batch.hashOrder(trader, wethIn, amountIn, minOut, salt);
        vm.prank(trader);
        batch.commit(commitId);
    }

    function _reveal(address trader, bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt) internal {
        vm.prank(trader);
        batch.reveal(wethIn, amountIn, minOut, salt);
    }

    /// The headline claim: offsetting orders never reach the pool, so an indexer
    /// watching the AMM sees only the net remainder.
    function test_offsettingOrdersNeverTouchThePool() public {
        uint256 reserveWethBefore = amm.reserveWeth();

        // Two buyers want 10 WETH of MEME between them. A seller is unwinding
        // roughly 10 WETH worth of MEME in the same batch.
        _submit(buyerA, true, 6 ether, 0, "a");
        _submit(buyerB, true, 4 ether, 0, "b");
        _submit(seller, false, 100_000 ether, 0, "s");

        vm.roll(block.number + 2);

        _reveal(buyerA, true, 6 ether, 0, "a");
        _reveal(buyerB, true, 4 ether, 0, "b");
        _reveal(seller, false, 100_000 ether, 0, "s");

        vm.recordLogs();
        batch.settleBatch();

        // The seller brings 100,000 MEME = 10 WETH at spot, exactly offsetting the
        // two buyers. Nothing is left over, so the pool never moves.
        assertEq(amm.reserveWeth(), reserveWethBefore, "pool reserves must be untouched");

        uint256 swaps = 0;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(amm) && logs[i].topics[0] == SimpleAMM.Swap.selector) swaps++;
        }
        assertEq(swaps, 0, "a fully matched batch emits no Swap for an indexer to read");

        console.log("buyerA MEME ", meme.balanceOf(buyerA));
        console.log("buyerB MEME ", meme.balanceOf(buyerB));
        console.log("seller WETH ", weth.balanceOf(seller));
    }

    /// Only the imbalance is visible, and it is smaller than the orders behind it.
    function test_poolOnlySeesTheNetRemainder() public {
        _submit(buyerA, true, 10 ether, 0, "a");
        _submit(seller, false, 50_000 ether, 0, "s");

        vm.roll(block.number + 2);

        _reveal(buyerA, true, 10 ether, 0, "a");
        _reveal(seller, false, 50_000 ether, 0, "s");

        uint256 reserveWethBefore = amm.reserveWeth();
        batch.settleBatch();
        uint256 poolSaw = amm.reserveWeth() - reserveWethBefore;

        // 50,000 MEME is 5 WETH at spot, so 5 of the buyer's 10 WETH is matched
        // internally and the pool only ever sees the other 5.
        assertEq(poolSaw, 5 ether, "pool should see only the unmatched half");
        console.log("buyer traded (WETH) ", uint256(10 ether));
        console.log("pool observed (WETH)", poolSaw);
    }

    /// Everyone on the same side of a batch clears at one price, so there is no
    /// ordering advantage to buy inside the batch.
    function test_buyersInABatchClearAtTheSamePrice() public {
        _submit(buyerA, true, 2 ether, 0, "a");
        _submit(buyerB, true, 8 ether, 0, "b");

        vm.roll(block.number + 2);

        _reveal(buyerA, true, 2 ether, 0, "a");
        _reveal(buyerB, true, 8 ether, 0, "b");

        batch.settleBatch();

        uint256 priceA = (meme.balanceOf(buyerA) * 1e18) / 2 ether;
        uint256 priceB = (meme.balanceOf(buyerB) * 1e18) / 8 ether;

        console.log("buyerA price", priceA);
        console.log("buyerB price", priceB);
        assertApproxEqAbs(priceA, priceB, 1e6, "both buyers clear at the same price");
    }

    function test_settleRevertsOnEmptyBatch() public {
        vm.expectRevert(BatchVeilSwap.EmptyBatch.selector);
        batch.settleBatch();
    }

    function test_slippageLimitStillProtectsTheTrader() public {
        // Demand an impossible payout and the whole batch refuses to settle.
        _submit(buyerA, true, 10 ether, 500_000 ether, "a");
        vm.roll(block.number + 2);
        _reveal(buyerA, true, 10 ether, 500_000 ether, "a");

        vm.expectRevert();
        batch.settleBatch();
    }
}
