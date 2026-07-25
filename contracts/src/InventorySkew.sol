// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

/// @dev Cap on maxSkewBps: 10% on the 1e9 BPS base. Constraining dangerous
///      parameter ranges at the builder level is a PROGRAMS.md recommendation;
///      the instruction re-checks it on-chain because hand-rolled bytecode
///      bypasses builders.
uint256 constant MAX_SKEW_CAP = BPS / 10;

library InventorySkewArgsBuilder {
    using Calldata for bytes;

    error InventorySkewMissingArgs();
    error InventorySkewZeroTarget();
    error InventorySkewTooLarge();

    /// @param target0 target holding of the lower-address token of the pair
    /// @param target1 target holding of the higher-address token of the pair
    /// @param maxSkewBps max price adjustment on the 1e9 BPS base (<= 10%)
    function build(
        uint128 target0,
        uint128 target1,
        uint32 maxSkewBps
    ) internal pure returns (bytes memory) {
        require(target0 > 0 && target1 > 0, InventorySkewZeroTarget());
        require(maxSkewBps <= MAX_SKEW_CAP, InventorySkewTooLarge());
        return abi.encodePacked(target0, target1, maxSkewBps);
    }

    function parse(
        bytes calldata args
    ) internal pure returns (uint256 target0, uint256 target1, uint256 maxSkewBps) {
        target0 = uint128(bytes16(args.slice(0, 16, InventorySkewMissingArgs.selector)));
        target1 = uint128(bytes16(args.slice(16, 32, InventorySkewMissingArgs.selector)));
        maxSkewBps = uint32(bytes4(args.slice(32, 36, InventorySkewMissingArgs.selector)));
    }
}

/// @title InventorySkew
/// @notice Self-balancing price tilt: the further the strategy's holdings
///         drift from its target split, the better the price offered to
///         takers whose trade restores the target - and the worse for takers
///         who deepen the drift.
/// @dev Bacalhau's custom instruction. Stateless and deterministic: identical
///      behavior in quote (static) and swap contexts. Must run BEFORE the
///      core swap instruction (price-modifier slot), like Decay.
///      Both adjustments only ever SHRINK a virtual balance, so computed
///      amounts always stay within the strategy's real balances.
contract InventorySkew {
    error InventorySkewShouldBeCalledBeforeSwapAmountsComputation(uint256 amountIn, uint256 amountOut);
    error InventorySkewZeroTargets();
    error InventorySkewExceedsCap();

    /// @param args target0 (uint128) | target1 (uint128) | maxSkewBps (uint32)
    ///        targets are keyed to the address-sorted token pair, so one
    ///        argument blob serves both trade directions (XD).
    function _inventorySkewXD(Context memory ctx, bytes calldata args) internal pure {
        require(
            ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0,
            InventorySkewShouldBeCalledBeforeSwapAmountsComputation(ctx.swap.amountIn, ctx.swap.amountOut)
        );

        (uint256 target0, uint256 target1, uint256 maxSkewBps) = InventorySkewArgsBuilder.parse(args);
        require(target0 > 0 && target1 > 0, InventorySkewZeroTargets());
        // Re-check the builder cap: beyond it, drift * maxSkewBps / BPS can
        // exceed BPS (underflow revert) or shrink a balance to near zero.
        require(maxSkewBps <= MAX_SKEW_CAP, InventorySkewExceedsCap());

        // Orient canonical (address-sorted) targets to this trade's in/out.
        (uint256 targetIn, uint256 targetOut) = ctx.query.tokenIn < ctx.query.tokenOut
            ? (target0, target1)
            : (target1, target0);

        // Cross-multiplied relative holdings: inWeight vs outWeight compares
        // balanceIn/targetIn against balanceOut/targetOut without division.
        uint256 inWeight = ctx.swap.balanceIn * targetOut;
        uint256 outWeight = ctx.swap.balanceOut * targetIn;
        if (inWeight == outWeight) return; // perfectly balanced

        // Drift in [0, BPS): normalized distance from target split.
        uint256 drift = inWeight > outWeight
            ? (inWeight - outWeight) * BPS / (inWeight + outWeight)
            : (outWeight - inWeight) * BPS / (inWeight + outWeight);
        uint256 skew = drift * maxSkewBps / BPS; // linear in drift, <= maxSkewBps

        if (inWeight < outWeight) {
            // Strategy is short of tokenIn: this trade restores the target.
            // Better price for the taker: virtually shrink balanceIn.
            ctx.swap.balanceIn = ctx.swap.balanceIn * (BPS - skew) / BPS;
        } else {
            // Strategy already has excess tokenIn: this trade deepens drift.
            // Worse price for the taker: virtually shrink balanceOut.
            ctx.swap.balanceOut = ctx.swap.balanceOut * (BPS - skew) / BPS;
        }
    }
}
