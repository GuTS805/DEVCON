// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @notice Constant-product pool (x * y = k), no fee, matching the Session 1 lab numbers.
/// @dev Swapping directly against this contract is the *unprotected* path: the call data
///      sits in the public mempool where a searcher can read size and direction.
contract SimpleAMM {
    MockERC20 public immutable weth;
    MockERC20 public immutable meme;

    uint256 public reserveWeth;
    uint256 public reserveMeme;

    event Swap(address indexed trader, bool wethIn, uint256 amountIn, uint256 amountOut);

    error InsufficientOutput(uint256 got, uint256 minOut);

    constructor(MockERC20 _weth, MockERC20 _meme) {
        weth = _weth;
        meme = _meme;
    }

    function addLiquidity(uint256 wethAmount, uint256 memeAmount) external {
        weth.transferFrom(msg.sender, address(this), wethAmount);
        meme.transferFrom(msg.sender, address(this), memeAmount);
        reserveWeth += wethAmount;
        reserveMeme += memeAmount;
    }

    /// @notice Output for a given input under x*y=k.
    function quote(bool wethIn, uint256 amountIn) public view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut) =
            wethIn ? (reserveWeth, reserveMeme) : (reserveMeme, reserveWeth);
        return (reserveOut * amountIn) / (reserveIn + amountIn);
    }

    /// @notice Price with zero size — what the trader believes they will get per unit.
    function spotPrice() external view returns (uint256) {
        return (reserveMeme * 1e18) / reserveWeth;
    }

    function swap(bool wethIn, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        amountOut = quote(wethIn, amountIn);
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        if (wethIn) {
            weth.transferFrom(msg.sender, address(this), amountIn);
            reserveWeth += amountIn;
            reserveMeme -= amountOut;
            meme.transfer(recipient, amountOut);
        } else {
            meme.transferFrom(msg.sender, address(this), amountIn);
            reserveMeme += amountIn;
            reserveWeth -= amountOut;
            weth.transfer(recipient, amountOut);
        }

        emit Swap(msg.sender, wethIn, amountIn, amountOut);
    }
}
