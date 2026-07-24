// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import { MockTaker } from "@1inch/swap-vm/test/mocks/MockTaker.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { InventorySkewArgsBuilder } from "../src/InventorySkew.sol";

/// @title DemoEnv
/// @notice One-shot local demo environment: Aqua + BacalhauRouter + mock
///         WETH/USDC, a seeded "Self-balancing MM" strategy shipped by the
///         deployer, and one taker swap so the dashboard is not empty
///         (docs/07 Beat 0). Writes addresses to deployments/local.json.
contract DemoEnv is Script {
    // Opcodes (must match app/src/compiler/opcodes.ts and the golden tests)
    uint8 internal constant OP_DEADLINE = 0x0d;
    uint8 internal constant OP_XYC_SWAP = 0x11;
    uint8 internal constant OP_SALT = 0x14;
    uint8 internal constant OP_FLAT_FEE_IN = 0x15;
    uint8 internal constant OP_INVENTORY_SKEW = 0x22;

    uint32 internal constant FEE_030 = uint32(3 * uint256(BPS) / 1000); // 0.3%
    uint32 internal constant MAX_SKEW = uint32(uint256(BPS) / 20); // 5%

    uint128 internal constant SEED_WETH = 100e18;
    uint128 internal constant SEED_USDC = 200_000e18; // mock, 18 decimals

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        // Core protocol (official bytecode, locally deployed + our router)
        Aqua aqua = new Aqua();
        BacalhauRouter router = new BacalhauRouter(
            address(aqua), address(0), deployer, "SwapVM", "1.0.0"
        );

        // Demo tokens
        TokenMock weth = new TokenMock("Wrapped Ether (demo)", "WETH");
        TokenMock usdc = new TokenMock("USD Coin (demo)", "USDC");
        weth.mint(deployer, 1_000e18);
        usdc.mint(deployer, 2_000_000e18);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);

        // Seed strategy: Self-balancing MM (skew -> fee -> xyc -> salt)
        ISwapVM.Order memory order = _selfBalancingOrder(deployer, address(weth), address(usdc));
        bytes32 strategyHash = aqua.ship(
            address(router),
            abi.encode(order),
            _tokens(address(weth), address(usdc)),
            _amounts(SEED_WETH, SEED_USDC)
        );

        // One taker swap so the dashboard opens with history
        MockTaker taker = new MockTaker(aqua, router, deployer);
        weth.mint(address(taker), 10e18);
        taker.swap(
            order,
            address(weth),
            address(usdc),
            1e18,
            TakerTraitsLib.build(TakerTraitsLib.Args({
                taker: address(taker),
                isExactIn: true,
                shouldUnwrapWeth: false,
                hasPreTransferInCallback: true,
                hasPreTransferOutCallback: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: false,
                threshold: "",
                to: address(0),
                deadline: 0,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            }))
        );

        vm.stopBroadcast();

        // Addresses for the app (app/src reads this file in dev mode)
        string memory json = "deployment";
        vm.serializeAddress(json, "aqua", address(aqua));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "weth", address(weth));
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeAddress(json, "maker", deployer);
        vm.serializeAddress(json, "taker", address(taker));
        string memory out = vm.serializeBytes32(json, "seedStrategyHash", strategyHash);
        vm.writeJson(out, "deployments/local.json");

        console2.log("aqua        ", address(aqua));
        console2.log("router      ", address(router));
        console2.log("weth        ", address(weth));
        console2.log("usdc        ", address(usdc));
        console2.log("seed strategy hash:");
        console2.logBytes32(strategyHash);
    }

    function _selfBalancingOrder(
        address maker,
        address weth,
        address usdc
    ) internal view returns (ISwapVM.Order memory) {
        (uint128 t0, uint128 t1) = weth < usdc ? (SEED_WETH, SEED_USDC) : (SEED_USDC, SEED_WETH);
        bytes memory skewArgs = InventorySkewArgsBuilder.build(t0, t1, MAX_SKEW);

        bytes memory program = bytes.concat(
            abi.encodePacked(OP_INVENTORY_SKEW, uint8(skewArgs.length), skewArgs),
            abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), FEE_030),
            abi.encodePacked(OP_XYC_SWAP, uint8(0)),
            abi.encodePacked(OP_SALT, uint8(32), keccak256("bacalhau.demo.seed.v1"))
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

    function _tokens(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
