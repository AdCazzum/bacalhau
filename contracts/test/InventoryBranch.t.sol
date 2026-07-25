// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { AquaSwapVMTest } from "@1inch/swap-vm/test/base/AquaSwapVMTest.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Controls, ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { Fee, FeeArgsBuilder, BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { InventoryBranch, InventoryBranchArgsBuilder } from "../src/InventoryBranch.sol";
import { InventorySkewArgsBuilder } from "../src/InventorySkew.sol";

/// @title InventoryBranch (opcode 0x23) - on-chain behaviour
/// @notice Every case ships a real strategy on Aqua and observes the price the
///         VM actually quotes/settles. The branch itself is invisible: the only
///         way to see which way it went is which leg priced the trade, so each
///         leg carries a different flat fee and the assertions pin the exact
///         amount that leg must produce.
contract InventoryBranchTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    /// Bacalhau's custom opcodes, appended after the 34 stock Aqua opcodes.
    uint8 internal constant OP_INVENTORY_SKEW = 0x22;
    uint8 internal constant OP_INVENTORY_BRANCH = 0x23;

    /// The two legs, told apart by the fee they charge (BPS base is 1e9).
    uint32 internal constant FEE_CHEAP = uint32(1e6); // 0.1%, on the jump target
    uint32 internal constant FEE_DEAR = uint32(1e7); // 1.0%, on the fallthrough
    uint32 internal constant MAX_SKEW = uint32(uint256(BPS) / 20); // 5%

    uint256 internal constant TRADE = 100e18;

    function _deployRouter() internal override returns (SwapVM) {
        return new BacalhauRouter(address(aqua), address(0), address(this), "SwapVM", "1.0.0");
    }

    // ============ pair orientation ============
    // The instruction keys its targets to the address-sorted pair, so the whole
    // suite speaks token0/token1 and maps to the harness' tokenA/tokenB here.

    function _token0IsA() internal view returns (bool) {
        return address(tokenA) < address(tokenB);
    }

    function _ship(
        bytes memory program,
        uint256 reserve0,
        uint256 reserve1
    ) internal returns (ISwapVM.Order memory order, bytes32 strategyHash) {
        order = createStrategy(program);
        (uint256 reserveA, uint256 reserveB) = _token0IsA() ? (reserve0, reserve1) : (reserve1, reserve0);
        strategyHash = shipStrategy(order, tokenA, tokenB, reserveA, reserveB);
    }

    function _aquaBalances01(bytes32 strategyHash) internal view returns (uint256 balance0, uint256 balance1) {
        (uint256 balA, uint256 balB) = getAquaBalances(strategyHash);
        return _token0IsA() ? (balA, balB) : (balB, balA);
    }

    function _sp(bool sellToken0, uint256 amount, bool isExactIn) internal view returns (SwapProgram memory) {
        return SwapProgram({
            amount: amount,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: sellToken0 == _token0IsA(),
            isExactIn: isExactIn
        });
    }

    function _quoteExactIn(
        ISwapVM.Order memory order,
        bool sellToken0,
        uint256 amountIn
    ) internal view returns (uint256 amountOut) {
        (, amountOut) = quote(_sp(sellToken0, amountIn, true), order);
    }

    function _quoteExactOut(
        ISwapVM.Order memory order,
        bool sellToken0,
        uint256 amountOut
    ) internal view returns (uint256 amountIn) {
        (amountIn, ) = quote(_sp(sellToken0, amountOut, false), order);
    }

    // ============ reference pricing ============

    function _xycOut(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return amountIn * balanceOut / (balanceIn + amountIn);
    }

    /// Exact-in through `Fee._flatFeeAmountInXD` -> `XYCSwap._xycSwapXD`.
    function _feeXycOut(
        uint256 amountIn,
        uint32 feeBps,
        uint256 balanceIn,
        uint256 balanceOut
    ) internal pure returns (uint256) {
        uint256 netIn = amountIn - Math.ceilDiv(amountIn * feeBps, BPS);
        return netIn * balanceOut / (balanceIn + netIn);
    }

    /// Exact-out through the same pair of instructions (fee is added afterwards).
    function _feeXycIn(
        uint256 amountOut,
        uint32 feeBps,
        uint256 balanceIn,
        uint256 balanceOut
    ) internal pure returns (uint256) {
        uint256 grossIn = Math.ceilDiv(amountOut * balanceIn, balanceOut - amountOut);
        return grossIn + Math.ceilDiv(grossIn * feeBps, BPS - feeBps);
    }

    // ============ program assembly ============

    function _branchIns(uint128 target0, uint128 target1, uint16 nextPC) internal pure returns (bytes memory) {
        return _rawBranchIns(InventoryBranchArgsBuilder.build(target0, target1, nextPC));
    }

    /// Bypasses the args builder so malformed blobs reach the instruction.
    function _rawBranchIns(bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(OP_INVENTORY_BRANCH, uint8(args.length), args);
    }

    function _skewIns(uint128 target0, uint128 target1) internal pure returns (bytes memory) {
        bytes memory args = InventorySkewArgsBuilder.build(target0, target1, MAX_SKEW);
        return abi.encodePacked(OP_INVENTORY_SKEW, uint8(args.length), args);
    }

    /// A priceable leg: flat fee, then the shared constant-product swap.
    function _feeLeg(uint32 feeBps) internal pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            p.build(Fee._flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(feeBps)),
            p.build(XYCSwap._xycSwapXD)
        );
    }

    /// A leg that reverts the moment it is executed: the deadline is long past.
    /// Used as a tripwire on the leg that must NOT run.
    function _poisonLeg() internal pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return p.build(Controls._deadline, ControlsArgsBuilder.buildDeadline(0));
    }

    /// Layout, with the branch's absolute `nextPC` pointing at `thenLeg`'s opcode:
    ///
    ///   0                     : 0x23 branch, jumps to thenPC when above target
    ///   branchLen             : elseLeg   (runs on fallthrough)
    ///   branchLen+elseLen     : jump -> endPC (hops over thenLeg)
    ///   thenPC                : thenLeg   (runs on jump)
    ///   endPC                 : salt      (both paths converge here)
    ///
    /// `salt` only makes the program bytes - and therefore the strategy hash -
    /// unique, so one test can ship several strategies side by side.
    function _twoLegProgram(
        uint128 target0,
        uint128 target1,
        bytes memory thenLeg,
        bytes memory elseLeg,
        uint256 salt
    ) internal pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        // nextPC does not change the encoded length, so a placeholder measures it.
        uint256 branchLen = _branchIns(target0, target1, 0).length;
        uint256 jumpLen = p.build(Controls._jump, ControlsArgsBuilder.buildJump(0)).length;

        uint16 thenPC = uint16(branchLen + elseLeg.length + jumpLen);
        uint16 endPC = uint16(thenPC + thenLeg.length);

        return bytes.concat(
            _branchIns(target0, target1, thenPC),
            elseLeg,
            p.build(Controls._jump, ControlsArgsBuilder.buildJump(endPC)),
            thenLeg,
            p.build(Controls._salt, abi.encodePacked(salt))
        );
    }

    /// The workhorse: cheap fee behind the branch, dear fee on the fallthrough.
    function _feeSelectorProgram(
        uint128 target0,
        uint128 target1,
        uint256 salt
    ) internal pure returns (bytes memory) {
        return _twoLegProgram(target0, target1, _feeLeg(FEE_CHEAP), _feeLeg(FEE_DEAR), salt);
    }

    /// A minimal program whose only job is to hand `args` to opcode 0x23.
    function _malformedBranchProgram(bytes memory args, uint256 salt) internal pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            _rawBranchIns(args),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(salt))
        );
    }

    function _expectSwapRevert(bytes memory program, bytes4 expectedError) internal {
        (ISwapVM.Order memory order, ) = _ship(program, 1000e18, 1000e18);
        SwapProgram memory sp = _sp(true, TRADE, true);
        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, 1000e18);

        vm.expectRevert(expectedError);
        swap(sp, order);
    }

    // ============ leg selection ============

    /// 1500:500 against a 1:1 target -> 1500*1000 > 500*1000 -> jump taken.
    function test_InventoryAboveTargetSplit_PricesOnJumpTargetLeg_AndSettles() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) =
            _ship(_feeSelectorProgram(1000e18, 1000e18, 1), 1500e18, 500e18);

        uint256 quoted = _quoteExactIn(order, true, TRADE);
        assertEq(quoted, _feeXycOut(TRADE, FEE_CHEAP, 1500e18, 500e18), "must price on the cheap jump-target leg");
        assertGt(
            quoted,
            _feeXycOut(TRADE, FEE_DEAR, 1500e18, 500e18),
            "cheap leg must beat what the fallthrough leg's fee would have produced"
        );

        SwapProgram memory sp = _sp(true, TRADE, true);
        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, 500e18);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);

        (, TokenMock tokenOut) = getTokenPair(sp);
        assertEq(amountOut, quoted, "swap must match quote: the branch is a pure state read");
        assertEq(tokenOut.balanceOf(address(taker)), amountOut, "taker received the output");

        (uint256 balance0, uint256 balance1) = _aquaBalances01(strategyHash);
        assertEq(balance0, 1500e18 + amountIn, "strategy took in the full amountIn");
        assertEq(balance1, 500e18 - amountOut, "strategy paid out amountOut");
    }

    /// Mirror inventory, 500:1500 -> predicate false -> fallthrough leg prices.
    function test_InventoryBelowTargetSplit_PricesOnFallthroughLeg_AndSettles() public {
        (ISwapVM.Order memory order, ) = _ship(_feeSelectorProgram(1000e18, 1000e18, 2), 500e18, 1500e18);

        uint256 quoted = _quoteExactIn(order, true, TRADE);
        assertEq(quoted, _feeXycOut(TRADE, FEE_DEAR, 500e18, 1500e18), "must price on the dear fallthrough leg");
        assertLt(
            quoted,
            _feeXycOut(TRADE, FEE_CHEAP, 500e18, 1500e18),
            "dear leg must be worse than what the jump target's fee would have produced"
        );

        SwapProgram memory sp = _sp(true, TRADE, true);
        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, 1500e18);
        (, uint256 amountOut) = swap(sp, order);
        assertEq(amountOut, quoted, "swap must match quote");
    }

    // ============ the headline property: direction independence ============

    /// One inventory, both trade directions and both exact-in/exact-out: the
    /// predicate describes the maker's book, not the taker's trade, so every
    /// observation must show the cheap (jump target) fee.
    function test_AboveTarget_EveryTradeDirectionTakesTheJumpTargetLeg() public {
        (ISwapVM.Order memory order, ) = _ship(_feeSelectorProgram(1000e18, 1000e18, 3), 1500e18, 500e18);

        uint256 sellingToken0 = _quoteExactIn(order, true, TRADE);
        uint256 sellingToken1 = _quoteExactIn(order, false, TRADE);
        uint256 buyingToken1 = _quoteExactOut(order, true, TRADE);

        assertEq(sellingToken0, _feeXycOut(TRADE, FEE_CHEAP, 1500e18, 500e18), "token0 -> token1 took the cheap leg");
        assertEq(sellingToken1, _feeXycOut(TRADE, FEE_CHEAP, 500e18, 1500e18), "token1 -> token0 took the cheap leg");
        assertEq(buyingToken1, _feeXycIn(TRADE, FEE_CHEAP, 1500e18, 500e18), "exact-out took the cheap leg");

        assertGt(sellingToken0, _feeXycOut(TRADE, FEE_DEAR, 1500e18, 500e18), "token0 -> token1 was not the dear leg");
        assertGt(sellingToken1, _feeXycOut(TRADE, FEE_DEAR, 500e18, 1500e18), "token1 -> token0 was not the dear leg");
        assertLt(buyingToken1, _feeXycIn(TRADE, FEE_DEAR, 1500e18, 500e18), "exact-out was not the dear leg");
    }

    /// Same claim on the other side of the predicate: a below-target book must
    /// fall through for every direction, never only for one of them.
    function test_BelowTarget_EveryTradeDirectionTakesTheFallthroughLeg() public {
        (ISwapVM.Order memory order, ) = _ship(_feeSelectorProgram(1000e18, 1000e18, 4), 500e18, 1500e18);

        uint256 sellingToken0 = _quoteExactIn(order, true, TRADE);
        uint256 sellingToken1 = _quoteExactIn(order, false, TRADE);
        uint256 buyingToken1 = _quoteExactOut(order, true, TRADE);

        assertEq(sellingToken0, _feeXycOut(TRADE, FEE_DEAR, 500e18, 1500e18), "token0 -> token1 took the dear leg");
        assertEq(sellingToken1, _feeXycOut(TRADE, FEE_DEAR, 1500e18, 500e18), "token1 -> token0 took the dear leg");
        assertEq(buyingToken1, _feeXycIn(TRADE, FEE_DEAR, 500e18, 1500e18), "exact-out took the dear leg");

        assertLt(sellingToken0, _feeXycOut(TRADE, FEE_CHEAP, 500e18, 1500e18), "token0 -> token1 was not the cheap leg");
        assertLt(sellingToken1, _feeXycOut(TRADE, FEE_CHEAP, 1500e18, 500e18), "token1 -> token0 was not the cheap leg");
        assertGt(buyingToken1, _feeXycIn(TRADE, FEE_CHEAP, 500e18, 1500e18), "exact-out was not the cheap leg");
    }

    // ============ boundary: strictly greater ============

    /// Target ratio 3:1; 1500:500 sits exactly on it (1500*1 == 500*3). The
    /// jump must need a strict excess, so one wei decides the leg.
    function test_ExactlyOnTargetSplit_DoesNotJump_ButOneWeiAboveDoes() public {
        (ISwapVM.Order memory onTarget, ) = _ship(_feeSelectorProgram(3, 1, 10), 1500e18, 500e18);
        (ISwapVM.Order memory oneWeiAbove, ) = _ship(_feeSelectorProgram(3, 1, 11), 1500e18 + 1, 500e18);
        (ISwapVM.Order memory oneWeiBelow, ) = _ship(_feeSelectorProgram(3, 1, 12), 1500e18 - 1, 500e18);

        assertEq(
            _quoteExactIn(onTarget, true, TRADE),
            _feeXycOut(TRADE, FEE_DEAR, 1500e18, 500e18),
            "exactly on target must fall through"
        );
        assertEq(
            _quoteExactIn(oneWeiAbove, true, TRADE),
            _feeXycOut(TRADE, FEE_CHEAP, 1500e18 + 1, 500e18),
            "one wei above target must jump"
        );
        assertEq(
            _quoteExactIn(oneWeiBelow, true, TRADE),
            _feeXycOut(TRADE, FEE_DEAR, 1500e18 - 1, 500e18),
            "one wei below target must fall through"
        );
    }

    // ============ control flow: only the selected leg executes ============

    /// The jump target is booby-trapped with an expired deadline. A below-target
    /// book must fall straight into the next instruction and never touch it.
    function test_PredicateFalse_FallsThroughAndNeverExecutesTheJumpTarget() public {
        bytes memory program = _twoLegProgram(
            1000e18,
            1000e18,
            bytes.concat(_poisonLeg(), _feeLeg(FEE_CHEAP)),
            _feeLeg(FEE_DEAR),
            20
        );
        (ISwapVM.Order memory order, ) = _ship(program, 500e18, 1500e18);

        assertEq(
            _quoteExactIn(order, true, TRADE),
            _feeXycOut(TRADE, FEE_DEAR, 500e18, 1500e18),
            "fallthrough leg priced the trade and the jump target never ran"
        );
    }

    /// Same trap on the fallthrough leg: an above-target book must jump clean
    /// over every instruction between the branch and its target.
    function test_PredicateTrue_JumpsOverTheFallthroughLegWithoutExecutingIt() public {
        bytes memory program = _twoLegProgram(
            1000e18,
            1000e18,
            _feeLeg(FEE_CHEAP),
            bytes.concat(_poisonLeg(), _feeLeg(FEE_DEAR)),
            21
        );
        (ISwapVM.Order memory order, ) = _ship(program, 1500e18, 500e18);

        assertEq(
            _quoteExactIn(order, true, TRADE),
            _feeXycOut(TRADE, FEE_CHEAP, 1500e18, 500e18),
            "jump target priced the trade and the skipped leg never ran"
        );
    }

    // ============ malformed args ============

    function test_ZeroTargetInHandRolledBytecode_RevertsWithZeroTargets() public {
        bytes4 expected = InventoryBranch.InventoryBranchZeroTargets.selector;
        _expectSwapRevert(
            _malformedBranchProgram(abi.encodePacked(uint128(0), uint128(1000e18), uint16(0)), 30),
            expected
        );
        _expectSwapRevert(
            _malformedBranchProgram(abi.encodePacked(uint128(1000e18), uint128(0), uint16(0)), 31),
            expected
        );
    }

    function test_ArgsShorterThan34Bytes_RevertWithMissingArgs() public {
        bytes4 expected = InventoryBranchArgsBuilder.InventoryBranchMissingArgs.selector;
        _expectSwapRevert(_malformedBranchProgram("", 40), expected); // no args at all
        _expectSwapRevert(_malformedBranchProgram(new bytes(16), 41), expected); // target1 truncated
        _expectSwapRevert(_malformedBranchProgram(new bytes(33), 42), expected); // nextPC truncated
    }

    /// The builder refuses to emit a branch that could only ever revert on-chain.
    function test_ArgsBuilder_RejectsAZeroTargetOnEitherSide() public {
        vm.expectRevert(InventoryBranchArgsBuilder.InventoryBranchZeroTarget.selector);
        this.buildBranchArgs(0, 1000e18, 0);

        vm.expectRevert(InventoryBranchArgsBuilder.InventoryBranchZeroTarget.selector);
        this.buildBranchArgs(1000e18, 0, 0);
    }

    /// External so the library revert crosses a call boundary vm can observe.
    function buildBranchArgs(uint128 target0, uint128 target1, uint16 nextPC) external pure returns (bytes memory) {
        return InventoryBranchArgsBuilder.build(target0, target1, nextPC);
    }

    // ============ coexistence with InventorySkew (0x22) ============

    /// Both Bacalhau opcodes in one program, in the order the instruction's
    /// docs prescribe (branch first, price modifier on the taken leg). A shift
    /// in the append-only opcode table would feed 34-byte branch args to the
    /// skew parser (revert) or 36-byte skew args to the branch (bogus jump).
    function test_BranchAndSkew_BothDispatchInOneProgram() public {
        Program memory p = ProgramBuilder.init(_opcodes());
        bytes memory plainLeg = p.build(XYCSwap._xycSwapXD);
        bytes memory skewedLeg = bytes.concat(_skewIns(1000e18, 1000e18), plainLeg);

        (ISwapVM.Order memory above, ) =
            _ship(_twoLegProgram(1000e18, 1000e18, skewedLeg, plainLeg, 50), 1500e18, 500e18);
        (ISwapVM.Order memory below, ) =
            _ship(_twoLegProgram(1000e18, 1000e18, skewedLeg, plainLeg, 51), 500e18, 1500e18);

        // Above target, selling token0 deepens the drift: drift is 50%, so the
        // skew is MAX_SKEW/2 = 2.5% and it shrinks the virtual balanceOut.
        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkBalanceOut = 500e18 * (BPS - skew) / BPS;

        uint256 skewedQuote = _quoteExactIn(above, true, TRADE);
        assertEq(skewedQuote, _xycOut(TRADE, 1500e18, shrunkBalanceOut), "0x22 ran on the leg 0x23 jumped to");
        assertLt(skewedQuote, _xycOut(TRADE, 1500e18, 500e18), "skew penalised the drift-deepening trade");

        assertEq(
            _quoteExactIn(below, true, TRADE),
            _xycOut(TRADE, 500e18, 1500e18),
            "fallthrough leg is plain XYC: the skew was branched around"
        );
    }
}
