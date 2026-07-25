// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { stdError } from "forge-std/StdError.sol";

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AquaSwapVMTest } from "@1inch/swap-vm/test/base/AquaSwapVMTest.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Controls } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { InventorySkew, InventorySkewArgsBuilder, MAX_SKEW_CAP } from "../src/InventorySkew.sol";

contract InventorySkewTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    /// InventorySkew opcode: appended right after the 34 stock Aqua opcodes.
    uint8 internal constant OP_INVENTORY_SKEW = 0x22;
    uint32 internal constant MAX_SKEW = uint32(uint256(BPS) / 20); // 5%

    /// Asymmetric mixed-decimal targets mirroring the deployed seed strategy:
    /// tokenA plays 18-decimals WETH (100e18), tokenB 6-decimals USDC (200_000e6).
    uint128 internal constant TARGET_WETH = 100e18;
    uint128 internal constant TARGET_USDC = 200_000e6;

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

    function _quoteExactOutAtoB(ISwapVM.Order memory order, uint256 amountOut) internal view returns (uint256 amountIn) {
        SwapProgram memory sp = SwapProgram({
            amount: amountOut, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: true, isExactIn: false
        });
        (amountIn, ) = quote(sp, order);
    }

    function _quoteExactOutBtoA(ISwapVM.Order memory order, uint256 amountOut) internal view returns (uint256 amountIn) {
        SwapProgram memory sp = SwapProgram({
            amount: amountOut, taker: taker, tokenA: tokenA, tokenB: tokenB,
            zeroForOne: false, isExactIn: false
        });
        (amountIn, ) = quote(sp, order);
    }

    /// External wrappers: vm.expectRevert must see one call spanning the whole
    /// quote (the harness makes a benign asView() call first, which would
    /// otherwise consume the expectation).
    function quoteAtoB(ISwapVM.Order memory order, uint256 amount) external view returns (uint256) {
        return _quoteAtoB(order, amount);
    }

    function quoteExactOutBtoA(ISwapVM.Order memory order, uint256 amountOut) external view returns (uint256) {
        return _quoteExactOutBtoA(order, amountOut);
    }

    function _xycOut(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return amountIn * balanceOut / (balanceIn + amountIn);
    }

    /// Exact-out inverse of XYCSwap: ceil-rounded, mirrors _xycSwapXD.
    function _xycIn(uint256 amountOut, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return Math.ceilDiv(amountOut * balanceIn, balanceOut - amountOut);
    }

    /// Hands raw (builder-bypassing) args straight to opcode 0x22.
    function _rawSkewProgram(bytes memory rawArgs, uint256 salt) internal pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            abi.encodePacked(OP_INVENTORY_SKEW, uint8(rawArgs.length), rawArgs),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(salt))
        );
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

    // ============ asymmetric mixed-decimal targets: the deployed seed shape ============
    // With target0 == target1 the orientation ternary in _inventorySkewXD is a
    // no-op; these targets are 2000x apart, so a swapped targetIn/targetOut
    // flips bonus into penalty and every exact assertion below fails.

    /// Reserves exactly on the asymmetric target: "balanced" must mean
    /// proportional-to-target, not equal balances.
    function test_AsymmetricTargets_OnTarget_NoAdjustment() public {
        ISwapVM.Order memory order = _ship(TARGET_WETH, TARGET_USDC, TARGET_WETH, TARGET_USDC);
        assertEq(
            _quoteAtoB(order, 10e18),
            _xycOut(10e18, TARGET_WETH, TARGET_USDC),
            "on-target book must price selling WETH like plain XYC"
        );
        assertEq(
            _quoteBtoA(order, 20_000e6),
            _xycOut(20_000e6, TARGET_USDC, TARGET_WETH),
            "on-target book must price selling USDC like plain XYC"
        );
    }

    /// 50 WETH / 300k USDC against the 100 / 200k target: weights are 1:3, so
    /// drift = 50% -> skew = MAX_SKEW/2 (exact). Selling WETH restores the
    /// target and must be priced on the skew-shrunk WETH (input) balance.
    function test_AsymmetricTargets_SellingScarceSide_GetsBonus() public {
        ISwapVM.Order memory order = _ship(TARGET_WETH, TARGET_USDC, 50e18, 300_000e6);
        uint256 amount = 5e18;

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkWeth = 50e18 * (BPS - skew) / BPS;

        uint256 got = _quoteAtoB(order, amount);
        assertEq(got, _xycOut(amount, shrunkWeth, 300_000e6), "bonus must shrink the WETH-in balance");
        assertGt(got, _xycOut(amount, 50e18, 300_000e6), "strictly better than plain XYC");
    }

    /// Same book, opposite direction: buying the scarce WETH deepens the
    /// drift and must be priced on the skew-shrunk WETH (output) balance.
    function test_AsymmetricTargets_BuyingScarceSide_GetsPenalty() public {
        ISwapVM.Order memory order = _ship(TARGET_WETH, TARGET_USDC, 50e18, 300_000e6);
        uint256 amount = 20_000e6;

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkWeth = 50e18 * (BPS - skew) / BPS;

        uint256 got = _quoteBtoA(order, amount);
        assertEq(got, _xycOut(amount, 300_000e6, shrunkWeth), "penalty must shrink the WETH-out balance");
        assertLt(got, _xycOut(amount, 300_000e6, 50e18), "strictly worse than plain XYC");
    }

    // ============ exact-out through the skew ============

    /// Exact-out on the bonus side: the shrunk-balanceIn rule must survive
    /// XYCSwap's ceil-rounded inverse formula.
    function test_AsymmetricTargets_ExactOut_RebalancingTrade_GetsBonus() public {
        ISwapVM.Order memory order = _ship(TARGET_WETH, TARGET_USDC, 50e18, 300_000e6);
        uint256 amountOut = 30_000e6; // buy USDC by selling the scarce WETH

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkWeth = 50e18 * (BPS - skew) / BPS;

        uint256 amountIn = _quoteExactOutAtoB(order, amountOut);
        assertEq(amountIn, _xycIn(amountOut, shrunkWeth, 300_000e6), "exact-out must price on skew-shrunk balanceIn");
        assertLt(amountIn, _xycIn(amountOut, 50e18, 300_000e6), "strictly cheaper than plain XYC");
    }

    /// Exact-out on the penalty side shrinks balanceOut, so the depth a taker
    /// can buy shrinks with it: below the shrunk balance the trade prices at
    /// the penalised rate; between the shrunk and the real balance it cannot
    /// be served at all (XYCSwap's balanceOut - amountOut underflows).
    function test_AsymmetricTargets_ExactOut_PenaltySide_DepthShrinksWithSkew() public {
        ISwapVM.Order memory order = _ship(TARGET_WETH, TARGET_USDC, 50e18, 300_000e6);

        uint256 skew = uint256(MAX_SKEW) / 2;
        uint256 shrunkWeth = 50e18 * (BPS - skew) / BPS; // 48.75e18

        uint256 amountIn = _quoteExactOutBtoA(order, 40e18);
        assertEq(amountIn, _xycIn(40e18, 300_000e6, shrunkWeth), "exact-out must price on skew-shrunk balanceOut");
        assertGt(amountIn, _xycIn(40e18, 300_000e6, 50e18), "strictly dearer than plain XYC");

        vm.expectRevert(stdError.arithmeticError);
        this.quoteExactOutBtoA(order, 49e18); // within the real 50e18, beyond the skewed depth
    }

    // ============ hand-rolled bytecode: the cap is re-checked on-chain ============

    /// The builder refuses maxSkewBps > MAX_SKEW_CAP; raw bytecode bypasses
    /// builders, so the instruction must re-check, mirroring the zero-target
    /// re-check. At exactly the cap it must still quote.
    function test_HandRolledSkewAboveCap_Reverts_AtCap_Quotes() public {
        (uint128 t0, uint128 t1) = address(tokenA) < address(tokenB)
            ? (TARGET_WETH, TARGET_USDC)
            : (TARGET_USDC, TARGET_WETH);

        bytes memory aboveCap = abi.encodePacked(t0, t1, type(uint32).max);
        ISwapVM.Order memory bad = createStrategy(_rawSkewProgram(aboveCap, 1));
        shipStrategy(bad, tokenA, tokenB, 50e18, 300_000e6);
        vm.expectRevert(InventorySkew.InventorySkewExceedsCap.selector);
        this.quoteAtoB(bad, 5e18);

        bytes memory atCap = abi.encodePacked(t0, t1, uint32(MAX_SKEW_CAP));
        ISwapVM.Order memory ok = createStrategy(_rawSkewProgram(atCap, 2));
        shipStrategy(ok, tokenA, tokenB, 50e18, 300_000e6);
        assertGt(_quoteAtoB(ok, 5e18), 0, "exactly at the cap must still quote");
    }
}
