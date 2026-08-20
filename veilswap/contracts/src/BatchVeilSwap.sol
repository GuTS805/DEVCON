// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";
import {SimpleAMM} from "./SimpleAMM.sol";

/// @notice Commit-reveal router that clears revealed orders as one uniform-price batch.
///
/// `VeilSwap` hides an order until it settles, which removes the front-run. It does not
/// hide the settled trade: the swap still appears on chain at full size, attributable to
/// the trader. This contract closes that second gap.
///
/// Orders revealed into the same batch are matched against each other first, at the spot
/// price recorded when the batch is settled. Only the unmatched remainder is swapped
/// against the pool. Anything that found a counterparty inside the batch never reaches
/// the AMM at all, so it produces no swap for an indexer to attribute, and every trader
/// on the same side of the batch clears at one identical price.
contract BatchVeilSwap {
    SimpleAMM public immutable amm;
    MockERC20 public immutable weth;
    MockERC20 public immutable meme;

    uint256 public immutable revealDelay;
    uint256 public immutable revealWindow;
    /// @dev How far the pool may move between the batch opening and settling, in bps.
    uint256 public immutable maxDriftBps;

    struct Commitment {
        address trader;
        uint64 commitBlock;
        bool revealed;
    }

    struct Order {
        address trader;
        bool wethIn;
        uint256 amountIn;
        uint256 minOut;
    }

    mapping(bytes32 => Commitment) public commitments;

    uint256 public batchId;
    /// @dev Pool price when the open batch received its first order. Matching is
    /// anchored to this, not to whatever the price is when someone settles.
    uint256 public spotAtOpen;
    /// @dev Orders revealed into a batch, awaiting settlement.
    mapping(uint256 => Order[]) internal batchOrders;
    /// @dev Totals per side of the open batch.
    uint256 public pendingWethIn;
    uint256 public pendingMemeIn;

    event Committed(bytes32 indexed commitId, address indexed trader, uint256 revealBlock);
    event RevealedIntoBatch(
        bytes32 indexed commitId, uint256 indexed batch, address indexed trader, bool wethIn, uint256 amountIn
    );
    event BatchSettled(
        uint256 indexed batch,
        uint256 orderCount,
        uint256 matchedWeth,
        uint256 poolWethIn,
        uint256 poolMemeIn,
        uint256 clearingPrice
    );

    error AlreadyCommitted();
    error UnknownCommitment();
    error NotYourCommitment();
    error AlreadyRevealed();
    error TooEarly(uint256 currentBlock, uint256 revealBlock);
    error Expired(uint256 currentBlock, uint256 deadline);
    error EmptyBatch();
    error BelowMinimum(address trader, uint256 got, uint256 minOut);
    error PriceMoved(uint256 spotAtOpen, uint256 spotNow);

    constructor(SimpleAMM _amm, uint256 _revealDelay, uint256 _revealWindow, uint256 _maxDriftBps) {
        amm = _amm;
        weth = _amm.weth();
        meme = _amm.meme();
        revealDelay = _revealDelay;
        revealWindow = _revealWindow;
        maxDriftBps = _maxDriftBps;

        weth.approve(address(_amm), type(uint256).max);
        meme.approve(address(_amm), type(uint256).max);
    }

    function hashOrder(address trader, bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(trader, wethIn, amountIn, minOut, salt));
    }

    function openOrderCount() external view returns (uint256) {
        return batchOrders[batchId].length;
    }

    function commit(bytes32 commitId) external {
        if (commitments[commitId].trader != address(0)) revert AlreadyCommitted();
        commitments[commitId] =
            Commitment({trader: msg.sender, commitBlock: uint64(block.number), revealed: false});
        emit Committed(commitId, msg.sender, block.number + revealDelay);
    }

    /// @notice Open a sealed order into the current batch. Tokens move now, the swap does not.
    function reveal(bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt) external {
        bytes32 commitId = hashOrder(msg.sender, wethIn, amountIn, minOut, salt);
        Commitment storage c = commitments[commitId];

        if (c.trader == address(0)) revert UnknownCommitment();
        if (c.trader != msg.sender) revert NotYourCommitment();
        if (c.revealed) revert AlreadyRevealed();

        uint256 revealBlock = uint256(c.commitBlock) + revealDelay;
        uint256 deadline = revealBlock + revealWindow;
        if (block.number < revealBlock) revert TooEarly(block.number, revealBlock);
        if (block.number > deadline) revert Expired(block.number, deadline);

        c.revealed = true;

        // The first order through the door fixes the rate the batch will match at.
        if (batchOrders[batchId].length == 0) spotAtOpen = amm.spotPrice();

        if (wethIn) {
            weth.transferFrom(msg.sender, address(this), amountIn);
            pendingWethIn += amountIn;
        } else {
            meme.transferFrom(msg.sender, address(this), amountIn);
            pendingMemeIn += amountIn;
        }

        batchOrders[batchId].push(
            Order({trader: msg.sender, wethIn: wethIn, amountIn: amountIn, minOut: minOut})
        );

        emit RevealedIntoBatch(commitId, batchId, msg.sender, wethIn, amountIn);
    }

    /// @notice Match the batch internally, swap only the remainder, pay everyone one price.
    function settleBatch() external {
        uint256 batch = batchId;
        Order[] storage orders = batchOrders[batch];
        if (orders.length == 0) revert EmptyBatch();

        uint256 buyIn = pendingWethIn;
        uint256 sellIn = pendingMemeIn;

        // Settlement is permissionless, so whoever calls this could move the pool in the
        // same transaction and pick the rate their own order clears at. Match at the
        // price the batch opened with, and refuse to settle at all if someone has shoved
        // the pool since — otherwise the leftover swap still fills at their rigged price.
        uint256 spot = spotAtOpen;
        uint256 spotNow = amm.spotPrice();
        uint256 drift = spotNow > spot ? spotNow - spot : spot - spotNow;
        if (drift * 10_000 > spot * maxDriftBps) revert PriceMoved(spot, spotNow);

        // How much of each side finds a counterparty inside the batch.
        uint256 sellInWeth = (sellIn * 1e18) / spot;
        uint256 matchedWeth = buyIn < sellInWeth ? buyIn : sellInWeth;
        uint256 matchedMeme = (matchedWeth * spot) / 1e18;

        // Only the unmatched remainder is visible to the pool.
        uint256 poolWethIn;
        uint256 poolMemeIn;
        uint256 buyersMeme = matchedMeme;
        uint256 sellersWeth = matchedWeth;

        if (buyIn > matchedWeth) {
            poolWethIn = buyIn - matchedWeth;
            buyersMeme += amm.swap(true, poolWethIn, 0, address(this));
        } else if (sellIn > matchedMeme) {
            poolMemeIn = sellIn - matchedMeme;
            sellersWeth += amm.swap(false, poolMemeIn, 0, address(this));
        }

        // One clearing price for everyone on the buy side.
        uint256 clearingPrice = buyIn == 0 ? spot : (buyersMeme * 1e18) / buyIn;

        for (uint256 i = 0; i < orders.length; i++) {
            Order storage o = orders[i];
            uint256 payout;
            if (o.wethIn) {
                payout = (buyersMeme * o.amountIn) / buyIn;
                if (payout < o.minOut) revert BelowMinimum(o.trader, payout, o.minOut);
                meme.transfer(o.trader, payout);
            } else {
                payout = (sellersWeth * o.amountIn) / sellIn;
                if (payout < o.minOut) revert BelowMinimum(o.trader, payout, o.minOut);
                weth.transfer(o.trader, payout);
            }
        }

        emit BatchSettled(batch, orders.length, matchedWeth, poolWethIn, poolMemeIn, clearingPrice);

        batchId = batch + 1;
        pendingWethIn = 0;
        pendingMemeIn = 0;
    }
}
