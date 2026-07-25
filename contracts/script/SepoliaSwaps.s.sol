// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { TokenMockDecimals } from "@1inch/swap-vm/test/mocks/TokenMockDecimals.sol";
import { MockTaker } from "@1inch/swap-vm/test/mocks/MockTaker.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { InventorySkewArgsBuilder } from "../src/InventorySkew.sol";

/// @title SepoliaSwaps
/// @notice Generates real Pulled/Pushed events against the deployed seed
///         strategy so the subgraph indexes live swap activity. Reconstructs
///         the exact seed order, deploys a funded MockTaker, and swaps a few
///         times in both directions.
/// @dev Reads deployed addresses from deployments/sepolia.json. Run with:
///      forge script script/SepoliaSwaps.s.sol:SepoliaSwaps \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaSwaps is Script {
    uint8 internal constant OP_XYC_SWAP = 0x11;
    uint8 internal constant OP_SALT = 0x14;
    uint8 internal constant OP_FLAT_FEE_IN = 0x15;
    uint8 internal constant OP_INVENTORY_SKEW = 0x22;

    uint32 internal constant FEE_030 = uint32(3 * uint256(BPS) / 1000);
    uint32 internal constant MAX_SKEW = uint32(uint256(BPS) / 20);
    uint128 internal constant SEED_WETH = 100e18;
    uint128 internal constant SEED_USDC = 200_000e6;

    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_DEPLOYER_PK");
        address maker = vm.addr(pk);

        string memory dep = vm.readFile("deployments/sepolia.json");
        Aqua aqua = Aqua(vm.parseJsonAddress(dep, ".aqua"));
        BacalhauRouter router = BacalhauRouter(payable(vm.parseJsonAddress(dep, ".router")));
        TokenMockDecimals weth = TokenMockDecimals(vm.parseJsonAddress(dep, ".weth"));
        TokenMockDecimals usdc = TokenMockDecimals(vm.parseJsonAddress(dep, ".usdc"));

        vm.startBroadcast(pk);

        // Taker needs tokens to trade in; mint and let it approve the router.
        MockTaker taker = new MockTaker(aqua, SwapVM(payable(address(router))), maker);
        weth.mint(address(taker), 50e18);
        usdc.mint(address(taker), 100_000e6);

        ISwapVM.Order memory order = _selfBalancingOrder(maker, address(weth), address(usdc));

        // Three swaps in alternating directions -> Pulled + Pushed per swap.
        _swap(taker, order, address(usdc), address(weth), 20_000e6); // buy WETH
        _swap(taker, order, address(weth), address(usdc), 5e18);      // sell WETH
        _swap(taker, order, address(usdc), address(weth), 10_000e6); // buy WETH

        vm.stopBroadcast();

        console2.log("taker ", address(taker));
        console2.log("swaps executed: 3");
    }

    function _swap(
        MockTaker taker,
        ISwapVM.Order memory order,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal {
        // Aqua mode: taker transfers tokenIn first, its callback pushes to Aqua.
        bytes memory td = TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker),
            isExactIn: true,
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: true,
            useTransferFromAndAquaPush: false,
            threshold: "",
            to: address(0),
            deadline: 0,
            hasPreTransferInCallback: true,
            hasPreTransferOutCallback: false,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: "",
            signature: ""
        }));
        taker.swap(order, tokenIn, tokenOut, amountIn, td);
    }

    function _selfBalancingOrder(
        address maker,
        address weth,
        address usdc
    ) internal pure returns (ISwapVM.Order memory) {
        (uint128 t0, uint128 t1) = weth < usdc ? (SEED_WETH, SEED_USDC) : (SEED_USDC, SEED_WETH);
        bytes memory skewArgs = InventorySkewArgsBuilder.build(t0, t1, MAX_SKEW);
        bytes memory program = bytes.concat(
            abi.encodePacked(OP_INVENTORY_SKEW, uint8(skewArgs.length), skewArgs),
            abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), FEE_030),
            abi.encodePacked(OP_XYC_SWAP, uint8(0)),
            abi.encodePacked(OP_SALT, uint8(32), keccak256("bacalhau.sepolia.seed.v1"))
        );
        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            receiver: address(0),
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: program
        }));
    }
}
