// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TokenMockDecimals } from "@1inch/swap-vm/test/mocks/TokenMockDecimals.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { SeedOrderLib, SEED_WETH, SEED_USDC, SEPOLIA_SEED_SALT } from "./SeedOrder.sol";

/// @title SepoliaRouterV2
/// @notice Redeploys BacalhauRouter after the on-chain skew-cap re-check was
///         added to InventorySkew, so the verified source matches the deployed
///         bytecode. Aqua, the tokens and the subgraph are untouched: the
///         old seed strategy is docked (a real lifecycle event the indexer
///         shows), the new router gets a fresh seed shipped under the v2
///         salt, and deployments/sepolia.json is rewritten in place.
/// @dev Run with:
///      forge script script/SepoliaRouterV2.s.sol:SepoliaRouterV2 \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaRouterV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_DEPLOYER_PK");
        address maker = vm.addr(pk);

        string memory dep = vm.readFile("deployments/sepolia.json");
        Aqua aqua = Aqua(vm.parseJsonAddress(dep, ".aqua"));
        address oldRouter = vm.parseJsonAddress(dep, ".router");
        bytes32 oldStrategyHash = vm.parseJsonBytes32(dep, ".seedStrategyHash");
        TokenMockDecimals weth = TokenMockDecimals(vm.parseJsonAddress(dep, ".weth"));
        TokenMockDecimals usdc = TokenMockDecimals(vm.parseJsonAddress(dep, ".usdc"));

        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);

        vm.startBroadcast(pk);

        // Close the v1 strategy on the old router; funds never left the
        // maker wallet, so docking only zeroes the allowance bookkeeping.
        aqua.dock(oldRouter, oldStrategyHash, tokens);

        BacalhauRouter router = new BacalhauRouter(address(aqua), address(weth), maker, "SwapVM", "1.0.0");

        // Maker already holds minted balances and gave Aqua max approval in
        // SepoliaEnv; only the ship is needed.
        ISwapVM.Order memory order =
            SeedOrderLib.selfBalancingOrder(maker, address(weth), address(usdc), SEPOLIA_SEED_SALT);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SEED_WETH;
        amounts[1] = SEED_USDC;
        bytes32 strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);

        vm.stopBroadcast();

        // Rewrite the deployment file, preserving the untouched fields.
        // deployBlock stays at the Aqua deploy block: it is the log-scan
        // start, and Aqua did not move.
        string memory json = "sepolia";
        vm.serializeAddress(json, "aqua", address(aqua));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeUint(json, "deployBlock", vm.parseJsonUint(dep, ".deployBlock"));
        vm.serializeAddress(json, "weth", address(weth));
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeUint(json, "usdcDecimals", 6);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "maker", maker);
        string memory out = vm.serializeBytes32(json, "seedStrategyHash", strategyHash);
        vm.writeJson(out, "deployments/sepolia.json");

        console2.log("docked v1", oldRouter);
        console2.log("router v2", address(router));
        console2.logBytes32(strategyHash);
    }
}
