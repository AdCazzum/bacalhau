// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { console2 } from "forge-std/console2.sol";

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { AquaSwapVMTest } from "@1inch/swap-vm/test/base/AquaSwapVMTest.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Fee, FeeArgsBuilder, BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { Controls } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

/// @title Golden tests for canvas templates
/// @notice The reference bytecode for each canvas template (docs/05). The TS
///         compiler in app/ must emit byte-identical programs; these tests are
///         the on-chain half of that contract: they also prove the program
///         actually ships on Aqua and settles a real swap.
contract GoldenProgramsTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    /// 0.3% on a 1e9 base (BPS constant from Fee.sol)
    uint32 internal constant FEE_30_BPS = uint32(3 * uint32(1e6));
    /// Fixed salt so golden bytes are deterministic (UI supplies its own salt).
    uint256 internal constant GOLDEN_SALT = uint256(keccak256("bacalhau.golden.v1"));

    uint256 internal constant RESERVE_A = 1_000e18;
    uint256 internal constant RESERVE_B = 1_000e18;

    /// Template "Passive AMM" (docs/05): Constant-Product -> Flat Fee.
    /// Aqua-backed: no balance instruction; ship() defines the reserves.
    function _passiveAmmProgram() internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            p.build(Fee._flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(FEE_30_BPS)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(GOLDEN_SALT))
        );
    }

    /// Golden bytes for "Passive AMM", pinned from ProgramBuilder output.
    /// Layout: [flatFeeIn opcode][len=4][fee=0x002dc6c0 = 3e6]
    ///         [xycSwap opcode][len=0]
    ///         [salt opcode][len=32][keccak256("bacalhau.golden.v1")]
    /// The TS compiler must reproduce these bytes exactly (app compiler fixtures).
    bytes internal constant PASSIVE_AMM_GOLDEN =
        hex"1504002dc6c0110014200cf8ae082572c3264391ea8f6c9b5017997876cd451b56941ef59da3b3b87bac";

    function test_PassiveAmm_GoldenBytes() public view {
        bytes memory bytecode = _passiveAmmProgram();
        assertEq(bytecode, PASSIVE_AMM_GOLDEN, "golden bytecode drifted - update fixtures in app/ too");
    }

    /// End-to-end: bytecode -> Aqua ship() -> taker swap -> balances settle.
    function test_PassiveAmm_ShipAndSwap() public {
        ISwapVM.Order memory order = createStrategy(_passiveAmmProgram());
        bytes32 strategyHash = shipStrategy(order, tokenA, tokenB, RESERVE_A, RESERVE_B);

        SwapProgram memory sp = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, RESERVE_B); // funds stay in maker wallet until pulled

        (uint256 makerABefore, uint256 makerBBefore) = getAquaBalances(strategyHash);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);
        (uint256 makerAAfter, uint256 makerBAfter) = getAquaBalances(strategyHash);

        // Expected: 0.3% fee shaved off the input (rounded up, matching
        // Fee._flatFeeAmountInXD's ceilDiv), then x*y=k on the net input.
        uint256 netIn = amountIn - Math.ceilDiv(amountIn * FEE_30_BPS, BPS);
        uint256 expectedOut = RESERVE_B * netIn / (RESERVE_A + netIn);

        assertEq(amountIn, sp.amount, "exact-in amount respected");
        assertEq(amountOut, expectedOut, "fee-adjusted constant-product output");
        assertEq(tokenB.balanceOf(address(taker)), amountOut, "taker received output");
        assertEq(makerAAfter, makerABefore + amountIn, "strategy gained full amountIn (fee included)");
        assertEq(makerBAfter, makerBBefore - amountOut, "strategy paid amountOut");

        // Fee sanity: taker got strictly less than the no-fee quote.
        uint256 noFeeOut = RESERVE_B * amountIn / (RESERVE_A + amountIn);
        assertLt(amountOut, noFeeOut, "fee was actually charged");
    }

    /// The same wallet backs a second strategy with the same tokens - Aqua's
    /// core claim (shared liquidity) exercised, and the demo's Q&A answer.
    function test_TwoStrategies_ShareOneWallet() public {
        ISwapVM.Order memory order1 = createStrategy(_passiveAmmProgram());
        bytes32 hash1 = shipStrategy(order1, tokenA, tokenB, RESERVE_A, RESERVE_B);

        Program memory p = ProgramBuilder.init(_opcodes());
        bytes memory program2 = bytes.concat(
            p.build(Fee._flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(FEE_30_BPS * 2)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(GOLDEN_SALT + 1))
        );
        ISwapVM.Order memory order2 = createStrategy(program2);
        bytes32 hash2 = shipStrategy(order2, tokenA, tokenB, RESERVE_A, RESERVE_B);

        assertNotEq(hash1, hash2, "distinct strategies");

        (uint256 a1, uint256 b1) = getAquaBalances(hash1);
        (uint256 a2, uint256 b2) = getAquaBalances(hash2);
        assertEq(a1 + a2, 2 * RESERVE_A, "virtual balances tracked per strategy");
        assertEq(b1 + b2, 2 * RESERVE_B, "virtual balances tracked per strategy");
    }
}
