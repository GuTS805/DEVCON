// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";
import {SimpleAMM} from "./SimpleAMM.sol";

/// @notice Commit-reveal router in front of a SimpleAMM pool.
///
/// The trade parameters never appear in the mempool as plaintext. A trader first
/// publishes only `keccak256(trader, wethIn, amountIn, minOut, salt)`. After
/// `revealDelay` blocks they call `reveal`, which validates the preimage and performs
/// the swap in the same transaction. A searcher therefore learns the size and
/// direction only once the swap has already settled — too late to bracket it.
contract VeilSwap {
    SimpleAMM public immutable amm;
    MockERC20 public immutable weth;
    MockERC20 public immutable meme;

    /// @dev Blocks that must pass between commit and reveal.
    uint256 public immutable revealDelay;
    /// @dev Blocks after the reveal window opens before the commitment goes stale.
    uint256 public immutable revealWindow;

    /// @dev How far the pool price may move between commit and reveal, in basis points.
    uint256 public immutable maxDriftBps;

    struct Commitment {
        address trader;
        uint64 commitBlock;
        bool revealed;
        /// @dev Pool price when the order was sealed. The reveal is anchored to it.
        uint256 spotAtCommit;
    }

    mapping(bytes32 => Commitment) public commitments;

    event Committed(bytes32 indexed commitId, address indexed trader, uint256 revealBlock);
    event Revealed(
        bytes32 indexed commitId,
        address indexed trader,
        bool wethIn,
        uint256 amountIn,
        uint256 amountOut
    );

    error AlreadyCommitted();
    error UnknownCommitment();
    error NotYourCommitment();
    error AlreadyRevealed();
    error TooEarly(uint256 currentBlock, uint256 revealBlock);
    error Expired(uint256 currentBlock, uint256 deadline);
    error PriceMoved(uint256 spotAtCommit, uint256 spotNow);

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

    /// @notice Hash a trade into the value that goes on chain at commit time.
    function hashOrder(address trader, bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(trader, wethIn, amountIn, minOut, salt));
    }

    /// @notice Publish a sealed order. Reveals nothing but that *some* trade is coming.
    function commit(bytes32 commitId) external {
        if (commitments[commitId].trader != address(0)) revert AlreadyCommitted();
        commitments[commitId] = Commitment({
            trader: msg.sender,
            commitBlock: uint64(block.number),
            revealed: false,
            spotAtCommit: amm.spotPrice()
        });
        emit Committed(commitId, msg.sender, block.number + revealDelay);
    }

    /// @notice Open the sealed order and execute it atomically.
    function reveal(bool wethIn, uint256 amountIn, uint256 minOut, bytes32 salt)
        external
        returns (uint256 amountOut)
    {
        bytes32 commitId = hashOrder(msg.sender, wethIn, amountIn, minOut, salt);
        Commitment storage c = commitments[commitId];

        if (c.trader == address(0)) revert UnknownCommitment();
        if (c.trader != msg.sender) revert NotYourCommitment();
        if (c.revealed) revert AlreadyRevealed();

        uint256 revealBlock = uint256(c.commitBlock) + revealDelay;
        uint256 deadline = revealBlock + revealWindow;
        if (block.number < revealBlock) revert TooEarly(block.number, revealBlock);
        if (block.number > deadline) revert Expired(block.number, deadline);

        // The reveal spells the order out in public calldata, so a searcher can read it
        // and try to move the price before this transaction lands. Anchoring to the
        // price at commit time makes that pointless: shift the pool far enough to be
        // worth attacking and the reveal reverts, stranding the front-run.
        uint256 spotNow = amm.spotPrice();
        uint256 drift = spotNow > c.spotAtCommit ? spotNow - c.spotAtCommit : c.spotAtCommit - spotNow;
        if (drift * 10_000 > c.spotAtCommit * maxDriftBps) revert PriceMoved(c.spotAtCommit, spotNow);

        c.revealed = true;

        MockERC20 tokenIn = wethIn ? weth : meme;
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        amountOut = amm.swap(wethIn, amountIn, minOut, msg.sender);

        emit Revealed(commitId, msg.sender, wethIn, amountIn, amountOut);
    }
}
