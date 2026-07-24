// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AquaSwapVMTest } from "@1inch/swap-vm/test/base/AquaSwapVMTest.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Controls } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { InventorySkewArgsBuilder } from "../src/InventorySkew.sol";

contract InventorySkewTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    /// InventorySkew opcode: appended right after the 34 stock Aqua opcodes.
    uint8 internal constant OP_INVENTORY_SKEW = 0x22;
    uint32 internal constant MAX_SKEW = uint32(uint256(BPS) / 20); // 5%

    function _deployRouter() internal override returns (SwapVM) {
        return new BacalhauRouter(address(aqua), address(0), address(this), "SwapVM", "1.0.0");
    }

    /// Targets are keyed to the address-sorted pair (token0 < token1).
    function _skewArgs(uint128 targetA, uint128 targetB) internal view returns (bytes memory) {
        (uint128 t0, uint128 t1) = address(tokenA) < address(tokenB)
            ? (targetA, targetB)
            : (targetB, targetA);
        return InventorySkewArgsBuilder.build(t0, t1, MAX_SKEW);
    }

    /// Template "Self-balancing MM" core: InventorySkew -> XYCSwap (fee omitted
    /// to keep price assertions exact).
    function _skewProgram(uint128 targetA, uint128 targetB) internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        bytes memory skewArgs = _skewArgs(targetA, targetB);
        return bytes.concat(
            abi.encodePacked(OP_INVENTORY_SKEW, uint8(skewArgs.length), skewArgs),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(uint256(keccak256("bacalhau.skew.v1"))))
        );
    }

    function _ship(
        uint128 targetA,
        uint128 targetB,
        uint256 reserveA,
        uint256 reserveB
    ) internal returns (ISwapVM.Order memory order) {
        order = createStrategy(_skewProgram(targetA, targetB));
        shipStrategy(order, tokenA, tokenB, reserveA, reserveB);
    }

    function _quoteAtoB(ISwapVM.Order memory order, uint256 amount) internal view returns (uint256 amountOut) {
        SwapProgram memory sp = SwapProgram({
            amount: amount, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: true, isExactIn: true
        });
        (, amountOut) = quote(sp, order);
    }

    function _quoteBtoA(ISwapVM.Order memory order, uint256 amount) internal view returns (uint256 amountOut) {
        SwapProgram memory sp = SwapProgram({
            amount: amount, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: false, isExactIn: true
        });
        (, amountOut) = quote(sp, order);
    }

    function _xycOut(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return amountIn * balanceOut / (balanceIn + amountIn);
    }

    // ============ balanced: skew is a no-op ============

    function test_BalancedInventory_NoAdjustment() public {
        ISwapVM.Order memory order = _ship(1000e18, 1000e18, 1000e18, 1000e18);
        uint256 amount = 100e18;
        assertEq(
            _quoteAtoB(order, amount),
            _xycOut(amount, 1000e18, 1000e18),
            "balanced strategy must price exactly like plain XYC"
        );
    }

    // ============ drifted: bonus and penalty, exact math ============

    /// Reserves 500 A / 1500 B vs target 1000/1000: strategy is short of A.
    /// drift = |500-1500|/(500+1500) = 50% -> skew = MAX_SKEW/2 = 2.5%.
    function test_RebalancingTrade_GetsBonus() public {
        ISwapVM.Order memory order = _ship(1000e18, 1000e18, 500e18, 1500e18);
        uint256 amount = 100e18;

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkBalanceIn = 500e18 * (BPS - skew) / BPS;
        uint256 expected = _xycOut(amount, shrunkBalanceIn, 1500e18);

        uint256 got = _quoteAtoB(order, amount); // selling A restores the target
        assertEq(got, expected, "bonus must equal XYC on skew-shrunk balanceIn");
        assertGt(got, _xycOut(amount, 500e18, 1500e18), "strictly better than plain XYC");
    }

    /// Same reserves, opposite direction: selling B deepens the drift.
    function test_DriftDeepeningTrade_GetsPenalty() public {
        ISwapVM.Order memory order = _ship(1000e18, 1000e18, 500e18, 1500e18);
        uint256 amount = 100e18;

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkBalanceOut = 500e18 * (BPS - skew) / BPS;
        uint256 expected = _xycOut(amount, 1500e18, shrunkBalanceOut);

        uint256 got = _quoteBtoA(order, amount);
        assertEq(got, expected, "penalty must equal XYC on skew-shrunk balanceOut");
        assertLt(got, _xycOut(amount, 1500e18, 500e18), "strictly worse than plain XYC");
    }

    // ============ end to end: the bonus trade actually settles ============

    function test_SkewSwap_SettlesOnAqua() public {
        ISwapVM.Order memory order = _ship(1000e18, 1000e18, 500e18, 1500e18);
        bytes32 strategyHash = swapVM.hash(order);

        SwapProgram memory sp = SwapProgram({
            amount: 100e18, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: true, isExactIn: true
        });
        mintTokenInToTaker(sp);
        mintTokenOutToMaker(sp, 1500e18);

        uint256 quoted = _quoteAtoB(order, sp.amount);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);

        assertEq(amountOut, quoted, "swap must match quote (stateless instruction)");
        assertEq(tokenB.balanceOf(address(taker)), amountOut, "taker paid out");

        (uint256 balA, uint256 balB) = getAquaBalances(strategyHash);
        assertEq(balA, 500e18 + amountIn, "virtual balance A settled");
        assertEq(balB, 1500e18 - amountOut, "virtual balance B settled");
    }

    // ============ the product claim: skew shrinks drift over a round trip ============

    /// After a rebalancing trade, drift must be smaller, and the incentive
    /// with it: a second identical trade gets a smaller bonus.
    function test_BonusDecreases_AsInventoryRebalances() public {
        ISwapVM.Order memory order = _ship(1000e18, 1000e18, 500e18, 1500e18);

        SwapProgram memory sp = SwapProgram({
            amount: 100e18, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: true, isExactIn: true
        });
        mintTokenInToTaker(sp, 200e18);
        mintTokenOutToMaker(sp, 1500e18);

        uint256 quote1 = _quoteAtoB(order, 100e18);
        (uint256 in1, uint256 out1) = swap(sp, order);

        // Bonus premium vs plain XYC, before and after the first trade.
        uint256 plain1 = _xycOut(100e18, 500e18, 1500e18);
        uint256 plain2 = _xycOut(100e18, 500e18 + in1, 1500e18 - out1);
        uint256 quote2 = _quoteAtoB(order, 100e18);

        assertEq(quote1, out1, "deterministic");
        uint256 premium1 = (quote1 - plain1) * 1e18 / plain1;
        uint256 premium2 = quote2 > plain2 ? (quote2 - plain2) * 1e18 / plain2 : 0;
        assertLt(premium2, premium1, "incentive must shrink as inventory rebalances");
    }
}
