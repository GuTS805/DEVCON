// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {VeilSwap} from "../src/VeilSwap.sol";

contract SandwichTest is Test {
    MockERC20 weth;
    MockERC20 meme;
    SimpleAMM amm;
    VeilSwap veil;

    address lp = address(0xA11CE);
    address victim = address(0xB0B);
    address searcher = address(0xBAD);

    uint256 constant POOL_WETH = 100 ether;
    uint256 constant POOL_MEME = 1_000_000 ether;
    uint256 constant VICTIM_IN = 10 ether;
    uint256 constant SEARCHER_IN = 5 ether;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        meme = new MockERC20("Meme Token", "MEME");
        amm = new SimpleAMM(weth, meme);
        veil = new VeilSwap(amm, 2, 50, 100);

        weth.mint(lp, POOL_WETH);
        meme.mint(lp, POOL_MEME);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(POOL_WETH, POOL_MEME);
        vm.stopPrank();

        weth.mint(victim, VICTIM_IN);
        weth.mint(searcher, SEARCHER_IN);
    }

    function _minOut(uint256 fair, uint256 slippageBps) internal pure returns (uint256) {
        return (fair * (10_000 - slippageBps)) / 10_000;
    }

    function test_unprotectedSwapGetsSandwiched() public {
        uint256 fair = amm.quote(true, VICTIM_IN);
        uint256 minOut = _minOut(fair, 1000); // 10% slippage tolerance

        // 1. Front-run: searcher buys MEME ahead of the victim, pushing the price up.
        vm.startPrank(searcher);
        weth.approve(address(amm), type(uint256).max);
        uint256 searcherMeme = amm.swap(true, SEARCHER_IN, 0, searcher);
        vm.stopPrank();

        // 2. Victim's swap lands at the worsened price but still inside their slippage.
        vm.startPrank(victim);
        weth.approve(address(amm), type(uint256).max);
        uint256 victimOut = amm.swap(true, VICTIM_IN, minOut, victim);
        vm.stopPrank();

        // 3. Back-run: searcher dumps the MEME back into the now-richer pool.
        vm.startPrank(searcher);
        meme.approve(address(amm), type(uint256).max);
        uint256 searcherWethBack = amm.swap(false, searcherMeme, 0, searcher);
        vm.stopPrank();

        uint256 victimLoss = fair - victimOut;
        uint256 searcherProfit = searcherWethBack - SEARCHER_IN;

        console.log("fair out        ", fair);
        console.log("victim out      ", victimOut);
        console.log("victim loss     ", victimLoss);
        console.log("searcher profit ", searcherProfit);

        assertLt(victimOut, fair, "victim should receive less than the fair quote");
        assertGe(victimOut, minOut, "attack stays inside the victim's slippage so the tx succeeds");
        assertGt(searcherProfit, 0, "sandwich should be profitable");
    }

    function test_veilSwapDeniesTheSandwich() public {
        uint256 fair = amm.quote(true, VICTIM_IN);
        uint256 minOut = _minOut(fair, 1000);
        bytes32 salt = keccak256("victim-secret");

        // The victim publishes only a hash. Nothing about size or direction is public.
        vm.startPrank(victim);
        weth.approve(address(veil), type(uint256).max);
        bytes32 commitId = veil.hashOrder(victim, true, VICTIM_IN, minOut, salt);
        veil.commit(commitId);
        vm.stopPrank();

        // A searcher watching the mempool sees the commit but cannot read the order,
        // so it has no direction to front-run. Time passes, then reveal executes
        // the swap atomically in the same transaction.
        vm.roll(block.number + 2);

        vm.prank(victim);
        uint256 victimOut = veil.reveal(true, VICTIM_IN, minOut, salt);

        console.log("fair out   ", fair);
        console.log("victim out ", victimOut);

        assertEq(victimOut, fair, "unsandwiched trade executes at the fair quote");
    }

    /// The reveal transaction carries the order in plaintext, so a searcher can read it
    /// out of the mempool and try to front-run the reveal itself. Anchoring the reveal to
    /// the price at commit time makes that attack fail instead of pay.
    function test_frontRunningTheRevealMakesItRevert() public {
        uint256 fair = amm.quote(true, VICTIM_IN);
        uint256 limit = _minOut(fair, 1000);
        bytes32 salt = keccak256("anchored");

        vm.startPrank(victim);
        weth.approve(address(veil), type(uint256).max);
        veil.commit(veil.hashOrder(victim, true, VICTIM_IN, limit, salt));
        vm.stopPrank();

        vm.roll(block.number + 2);

        // Searcher reads the pending reveal and buys ahead of it.
        vm.startPrank(searcher);
        weth.approve(address(amm), type(uint256).max);
        amm.swap(true, SEARCHER_IN, 0, searcher);
        vm.stopPrank();

        // Read the moved price before pranking — a call here would consume the prank.
        uint256 movedSpot = amm.spotPrice();

        // The victim's reveal now refuses to execute at the moved price.
        vm.expectRevert(abi.encodeWithSelector(VeilSwap.PriceMoved.selector, 10_000 ether, movedSpot));
        vm.prank(victim);
        veil.reveal(true, VICTIM_IN, limit, salt);

        // The searcher is left holding MEME it bought high, with no victim to sell into.
        assertGt(meme.balanceOf(searcher), 0, "front-run is stranded");
        assertLt(weth.balanceOf(searcher), SEARCHER_IN, "searcher is down on the attempt");
    }

    /// Ordinary price movement inside the tolerance still settles.
    function test_smallDriftStillReveals() public {
        uint256 fair = amm.quote(true, VICTIM_IN);
        uint256 limit = _minOut(fair, 1000);
        bytes32 salt = keccak256("small-drift");

        vm.startPrank(victim);
        weth.approve(address(veil), type(uint256).max);
        veil.commit(veil.hashOrder(victim, true, VICTIM_IN, limit, salt));
        vm.stopPrank();

        vm.roll(block.number + 2);

        // A 0.2 WETH trade moves spot well under the 1% bound.
        weth.mint(lp, 0.2 ether);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        amm.swap(true, 0.2 ether, 0, lp);
        vm.stopPrank();

        vm.prank(victim);
        uint256 got = veil.reveal(true, VICTIM_IN, limit, salt);
        assertGt(got, 0, "an honest small move should not block the trade");
    }

    function test_revealBeforeDelayReverts() public {
        bytes32 salt = keccak256("early");
        uint256 fair = amm.quote(true, VICTIM_IN);

        vm.startPrank(victim);
        weth.approve(address(veil), type(uint256).max);
        veil.commit(veil.hashOrder(victim, true, VICTIM_IN, _minOut(fair, 1000), salt));
        vm.expectRevert();
        veil.reveal(true, VICTIM_IN, _minOut(fair, 1000), salt);
        vm.stopPrank();
    }

    function test_otherTraderCannotRevealSomeoneElsesOrder() public {
        bytes32 salt = keccak256("steal");
        uint256 fair = amm.quote(true, VICTIM_IN);
        uint256 minOut = _minOut(fair, 1000);

        vm.prank(victim);
        veil.commit(veil.hashOrder(victim, true, VICTIM_IN, minOut, salt));

        vm.roll(block.number + 2);

        vm.prank(searcher);
        vm.expectRevert();
        veil.reveal(true, VICTIM_IN, minOut, salt);
    }
}
