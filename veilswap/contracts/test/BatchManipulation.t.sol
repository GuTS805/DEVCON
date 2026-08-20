// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {BatchVeilSwap} from "../src/BatchVeilSwap.sol";

/// Settles the batch and moves the pool in the same transaction.
///
/// `settleBatch` is permissionless and reads the pool's live spot price to decide how
/// much of the batch matches internally. A participant who can move that price in the
/// same transaction picks the rate their own order clears at.
contract SettlementAttacker {
    SimpleAMM immutable amm;
    BatchVeilSwap immutable batch;
    MockERC20 immutable weth;
    MockERC20 immutable meme;

    constructor(SimpleAMM _amm, BatchVeilSwap _batch) {
        amm = _amm;
        batch = _batch;
        weth = _amm.weth();
        meme = _amm.meme();
        weth.approve(address(_amm), type(uint256).max);
        meme.approve(address(_amm), type(uint256).max);
        weth.approve(address(_batch), type(uint256).max);
        meme.approve(address(_batch), type(uint256).max);
    }

    function seal(uint256 amountIn, bytes32 salt) external {
        batch.commit(batch.hashOrder(address(this), false, amountIn, 0, salt));
    }

    function open(uint256 amountIn, bytes32 salt) external {
        batch.reveal(false, amountIn, 0, salt);
    }

    function settleHonestly() external {
        batch.settleBatch();
    }

    /// Shove the price, settle at the rate that creates, then unwind the shove.
    function settleOnMyTerms(uint256 shove) external {
        uint256 memeBought = amm.swap(true, shove, 0, address(this));
        batch.settleBatch();
        amm.swap(false, memeBought, 0, address(this));
    }
}

contract BatchManipulationTest is Test {
    MockERC20 weth;
    MockERC20 meme;
    SimpleAMM amm;
    BatchVeilSwap batch;
    SettlementAttacker attacker;

    address lp = address(0xA11CE);
    address buyer = address(0xB0B);

    uint256 constant POOL_WETH = 100 ether;
    uint256 constant POOL_MEME = 1_000_000 ether;
    uint256 constant SELL_IN = 100_000 ether;
    uint256 constant BUY_IN = 10 ether;
    uint256 constant SHOVE = 20 ether;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        meme = new MockERC20("Meme Token", "MEME");
        amm = new SimpleAMM(weth, meme);
        batch = new BatchVeilSwap(amm, 2, 50, 100);
        attacker = new SettlementAttacker(amm, batch);

        weth.mint(lp, POOL_WETH);
        meme.mint(lp, POOL_MEME);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        meme.approve(address(amm), type(uint256).max);
        amm.addLiquidity(POOL_WETH, POOL_MEME);
        vm.stopPrank();

        weth.mint(buyer, 100 ether);
        vm.prank(buyer);
        weth.approve(address(batch), type(uint256).max);

        // The attacker holds MEME to sell in the batch, and WETH to shove the pool with.
        meme.mint(address(attacker), SELL_IN);
        weth.mint(address(attacker), 100 ether);
    }

    /// Queue one honest buyer and the attacker's sell order into the same batch.
    function _fillBatch() internal {
        bytes32 buyerSalt = keccak256("buyer");
        bytes32 attackerSalt = keccak256("attacker");

        bytes32 buyerCommit = batch.hashOrder(buyer, true, BUY_IN, 0, buyerSalt);
        vm.prank(buyer);
        batch.commit(buyerCommit);
        attacker.seal(SELL_IN, attackerSalt);

        vm.roll(block.number + 2);

        vm.prank(buyer);
        batch.reveal(true, BUY_IN, 0, buyerSalt);
        attacker.open(SELL_IN, attackerSalt);
    }

    /// Anchoring the match to the batch's opening price takes the settler's edge away:
    /// shoving the pool no longer changes the rate, and the drift bound stops the
    /// leftover swap filling at the rigged price. The attempt reverts outright.
    function test_settlerCannotBuyTheSettlementPrice() public {
        _fillBatch();

        uint256 snap = vm.snapshotState();

        attacker.settleHonestly();
        uint256 honestWeth = weth.balanceOf(address(attacker));
        uint256 honestBuyerMeme = meme.balanceOf(buyer);

        vm.revertToState(snap);

        vm.expectRevert();
        attacker.settleOnMyTerms(SHOVE);

        console.log("attacker WETH, honest settle ", honestWeth);
        console.log("buyer MEME,    honest settle ", honestBuyerMeme);
        console.log("rigged settle reverted");

        // The honest path is unharmed: the buyer still gets the full internal match.
        assertEq(honestBuyerMeme, 100_000 ether, "honest settlement is unchanged");
    }

    /// The bound has to leave ordinary movement alone, or nothing ever settles.
    function test_smallDriftStillSettles() public {
        _fillBatch();

        // A 0.3 WETH trade is well inside the 1% bound.
        weth.mint(lp, 0.3 ether);
        vm.startPrank(lp);
        weth.approve(address(amm), type(uint256).max);
        amm.swap(true, 0.3 ether, 0, lp);
        vm.stopPrank();

        attacker.settleHonestly();
        assertGt(meme.balanceOf(buyer), 0, "an honest small move should not block settlement");
    }
}
