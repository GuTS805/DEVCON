// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {BatchVeilSwap} from "../src/BatchVeilSwap.sol";

/// The batch is the newest arithmetic in this project and the easiest place to be
/// quietly wrong: it nets orders against each other, prices them off a recorded spot,
/// and pays everyone out by hand. These run it on random order books and check the
/// properties that have to hold whatever the sizes are.
contract BatchInvariantsTest is Test {
    MockERC20 weth;
    MockERC20 meme;
    SimpleAMM amm;
    BatchVeilSwap batch;

    address lp = address(0xA11CE);
    address buyerA = address(0xB1);
    address buyerB = address(0xB2);
    address seller = address(0x51);

    uint256 constant POOL_WETH = 100 ether;
    uint256 constant POOL_MEME = 1_000_000 ether;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        meme = new MockERC20("Meme Token", "MEME");
        amm = new SimpleAMM(weth, meme);
        batch = new BatchVeilSwap(amm, 2, 50, 100);

        weth.mint(lp, POOL_WETH);
        meme.mint(lp, POOL_MEME);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(POOL_WETH, POOL_MEME);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; i++) {
            address who = [buyerA, buyerB, seller][i];
            weth.mint(who, 1_000 ether);
            meme.mint(who, 2_000_000 ether);
            vm.startPrank(who);
            weth.approve(address(batch), type(uint256).max);
            meme.approve(address(batch), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _queue(address trader, bool wethIn, uint256 amountIn, bytes32 salt) internal {
        bytes32 id = batch.hashOrder(trader, wethIn, amountIn, 0, salt);
        vm.prank(trader);
        batch.commit(id);
    }

    function _open(address trader, bool wethIn, uint256 amountIn, bytes32 salt) internal {
        vm.prank(trader);
        batch.reveal(wethIn, amountIn, 0, salt);
    }

    /// Whatever the book looks like, the router must not end up holding anyone's money
    /// and must not conjure any. Integer division leaves dust; nothing else may remain.
    function testFuzz_batchKeepsNothingAndCreatesNothing(uint256 aIn, uint256 bIn, uint256 sIn) public {
        aIn = bound(aIn, 0.01 ether, 40 ether);
        bIn = bound(bIn, 0.01 ether, 40 ether);
        sIn = bound(sIn, 100 ether, 400_000 ether);

        uint256 wethBefore = weth.balanceOf(address(batch));
        uint256 memeBefore = meme.balanceOf(address(batch));

        _queue(buyerA, true, aIn, "a");
        _queue(buyerB, true, bIn, "b");
        _queue(seller, false, sIn, "s");
        vm.roll(block.number + 2);
        _open(buyerA, true, aIn, "a");
        _open(buyerB, true, bIn, "b");
        _open(seller, false, sIn, "s");

        batch.settleBatch();

        // Dust from integer division is expected; anything more means value stuck
        // inside the router or handed out that it never received.
        assertLe(weth.balanceOf(address(batch)) - wethBefore, 1e6, "WETH left in the router");
        assertLe(meme.balanceOf(address(batch)) - memeBefore, 1e6, "MEME left in the router");
    }

    /// Everyone on the same side of a batch is supposed to get the same rate. If that
    /// slips, being early or large inside a batch starts to pay, which is the thing
    /// batching exists to remove.
    function testFuzz_buyersOnTheSameSideClearAtOnePrice(uint256 aIn, uint256 bIn) public {
        aIn = bound(aIn, 0.05 ether, 30 ether);
        bIn = bound(bIn, 0.05 ether, 30 ether);

        _queue(buyerA, true, aIn, "a");
        _queue(buyerB, true, bIn, "b");
        vm.roll(block.number + 2);
        _open(buyerA, true, aIn, "a");
        _open(buyerB, true, bIn, "b");

        uint256 aBefore = meme.balanceOf(buyerA);
        uint256 bBefore = meme.balanceOf(buyerB);
        batch.settleBatch();

        uint256 priceA = ((meme.balanceOf(buyerA) - aBefore) * 1e18) / aIn;
        uint256 priceB = ((meme.balanceOf(buyerB) - bBefore) * 1e18) / bIn;

        // 1e-9 of relative slack covers the rounding, nothing more.
        assertApproxEqRel(priceA, priceB, 1e9, "buyers cleared at different prices");
    }

    /// The privacy claim in one assertion: whatever finds a counterparty inside the
    /// batch never reaches the pool, so the pool only ever sees the imbalance between
    /// the two sides — never the flow that produced it.
    ///
    /// The first version of this test asserted the pool saw no more than the buy side,
    /// which the fuzzer broke in twelve runs: when the sell side is larger the pool
    /// absorbs the excess MEME and pays out WETH against it. The imbalance is the
    /// quantity that actually bounds it.
    function testFuzz_poolOnlySeesTheImbalance(uint256 aIn, uint256 sIn) public {
        aIn = bound(aIn, 0.05 ether, 30 ether);
        sIn = bound(sIn, 100 ether, 300_000 ether);

        _queue(buyerA, true, aIn, "a");
        _queue(seller, false, sIn, "s");
        vm.roll(block.number + 2);
        _open(buyerA, true, aIn, "a");
        _open(seller, false, sIn, "s");

        // What the seller's MEME is worth in WETH at the rate the batch will match on.
        uint256 sellInWeth = (sIn * 1e18) / batch.spotAtOpen();
        uint256 imbalance = aIn > sellInWeth ? aIn - sellInWeth : sellInWeth - aIn;
        uint256 submitted = aIn + sellInWeth;

        uint256 reserveBefore = amm.reserveWeth();
        batch.settleBatch();
        uint256 reserveAfter = amm.reserveWeth();

        uint256 seen = reserveAfter > reserveBefore ? reserveAfter - reserveBefore : reserveBefore - reserveAfter;

        // Slippage on the leftover swap can only make the pool's side smaller, never
        // larger, so the imbalance is a ceiling rather than an estimate.
        assertLe(seen, imbalance + 1e6, "pool saw more than the imbalance");
        assertLt(seen, submitted, "netting did not hide any flow");
    }

    /// A single-sided batch has nothing to net, so the pool has to see all of it.
    /// This is the control: it shows the assertion above is measuring something.
    function testFuzz_unmatchedFlowReachesThePoolInFull(uint256 aIn) public {
        aIn = bound(aIn, 0.05 ether, 30 ether);

        _queue(buyerA, true, aIn, "a");
        vm.roll(block.number + 2);
        _open(buyerA, true, aIn, "a");

        uint256 reserveBefore = amm.reserveWeth();
        batch.settleBatch();

        assertEq(amm.reserveWeth() - reserveBefore, aIn, "unmatched flow should hit the pool whole");
    }
}
