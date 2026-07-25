// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { TokenMockDecimals } from "@1inch/swap-vm/test/mocks/TokenMockDecimals.sol";
import { MockTaker } from "@1inch/swap-vm/test/mocks/MockTaker.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { SeedOrderLib, SEPOLIA_SEED_SALT } from "./SeedOrder.sol";

/// @title SepoliaSwaps
/// @notice Generates real Pulled/Pushed events against the deployed seed
///         strategy so the subgraph indexes live swap activity. Reconstructs
///         the exact seed order, deploys a funded MockTaker, and swaps a few
///         times in both directions.
/// @dev Reads deployed addresses from deployments/sepolia.json. Run with:
///      forge script script/SepoliaSwaps.s.sol:SepoliaSwaps \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaSwaps is Script {
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

        ISwapVM.Order memory order =
            SeedOrderLib.selfBalancingOrder(maker, address(weth), address(usdc), SEPOLIA_SEED_SALT);

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
}
