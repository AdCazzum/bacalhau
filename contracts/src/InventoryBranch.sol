// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

library InventoryBranchArgsBuilder {
    using Calldata for bytes;

    error InventoryBranchMissingArgs();
    error InventoryBranchZeroTarget();

    /// @param target0 target holding of the lower-address token of the pair
    /// @param target1 target holding of the higher-address token of the pair
    /// @param nextPC program counter to jump to when the predicate holds
    function build(
        uint128 target0,
        uint128 target1,
        uint16 nextPC
    ) internal pure returns (bytes memory) {
        require(target0 > 0 && target1 > 0, InventoryBranchZeroTarget());
        return abi.encodePacked(target0, target1, nextPC);
    }

    function parse(
        bytes calldata args
    ) internal pure returns (uint256 target0, uint256 target1, uint256 nextPC) {
        target0 = uint128(bytes16(args.slice(0, 16, InventoryBranchMissingArgs.selector)));
        target1 = uint128(bytes16(args.slice(16, 32, InventoryBranchMissingArgs.selector)));
        nextPC = uint16(bytes2(args.slice(32, 34, InventoryBranchMissingArgs.selector)));
    }
}

/// @title InventoryBranch
/// @notice Conditional jump on the strategy's own inventory state: branch when
///         the strategy is holding MORE of the lower-address token than the
///         given target split implies. This is what turns a linear Bacalhau
///         program into a state machine - "above 70% ETH, stop accumulating
///         and switch to the distribution leg".
/// @dev Bacalhau's custom instruction. Stateless and deterministic: identical
///      behavior in quote (static) and swap contexts, and it never touches the
///      swap registers - it only moves the program counter.
///      Unlike the price-modifier instructions there is no ordering
///      requirement against the core swap instruction, but note that it reads
///      `ctx.swap.balanceIn`/`balanceOut` live: a price modifier that virtually
///      shrinks a balance (InventorySkew, Decay) changes what this instruction
///      sees, so branch FIRST and modify the price on the taken leg.
contract InventoryBranch {
    using ContextLib for Context;

    error InventoryBranchZeroTargets();

    /// @dev Jumps if the strategy holds more of the lower-address token than
    ///      the target split allows, i.e. `balance0 / balance1 > target0 / target1`.
    /// @dev LIMITATION: Jump targets are limited to uint16 (0-65,535), same as
    ///      Controls._jump. For larger programs use Extruction.
    /// @dev LIMITATION: `nextPC` is not validated, exactly as Controls._jump
    ///      does not validate it. A target pointing back at this instruction
    ///      spins until the gas limit and reverts with no data; a target inside
    ///      another instruction's arguments makes the VM read argument bytes as
    ///      opcodes. Bacalhau's compiler can emit neither — the strategy graph
    ///      is acyclic and labels only resolve to instruction boundaries, see
    ///      app/src/compiler/graph.ts — but hand-rolled bytecode carries the
    ///      same risk as stock jumps.
    /// @dev LIMITATION: signature-based (non-Aqua) orders never load balances,
    ///      so the predicate reads zeros and the branch becomes a silent no-op.
    ///      This instruction is for Aqua-backed strategies, like InventorySkew.
    /// @param args target0 (uint128) | target1 (uint128) | nextPC (uint16)
    ///        targets are keyed to the address-sorted token pair, so one
    ///        argument blob serves both trade directions (XD). The predicate is
    ///        a pure state read, so the program branches the same way no matter
    ///        which way the taker trades.
    function _jumpIfInventoryAboveXD(Context memory ctx, bytes calldata args) internal pure {
        (uint256 target0, uint256 target1, uint256 nextPC) = InventoryBranchArgsBuilder.parse(args);
        require(target0 > 0 && target1 > 0, InventoryBranchZeroTargets());

        // Orient this trade's balances to the canonical (address-sorted) pair
        // the targets are keyed to, exactly as InventorySkew orients its targets.
        (uint256 balance0, uint256 balance1) = ctx.query.tokenIn < ctx.query.tokenOut
            ? (ctx.swap.balanceIn, ctx.swap.balanceOut)
            : (ctx.swap.balanceOut, ctx.swap.balanceIn);

        // Cross-multiplied comparison of balance0/balance1 against
        // target0/target1, no division and therefore no truncation.
        // Targets are uint128 by construction, so a product only overflows for
        // balances above 2**128 - checked arithmetic reverts there rather than
        // wrapping, the same accepted behavior as InventorySkew's cross-multiply.
        if (balance0 * target1 > balance1 * target0) {
            ctx.setNextPC(nextPC);
        }
    }
}
