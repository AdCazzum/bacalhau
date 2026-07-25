// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TokenMockDecimals } from "@1inch/swap-vm/test/mocks/TokenMockDecimals.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { SeedOrderLib, SEED_WETH, SEED_USDC, SEPOLIA_SEED_SALT } from "./SeedOrder.sol";

/// @title SepoliaEnv
/// @notice Real deployment to Base Sepolia (no cheatcodes): deploys mock
///         WETH/USDC, Aqua, BacalhauRouter, mints to the maker, ships the seed
///         self-balancing strategy, and writes deployments/sepolia.json.
///         Swaps (Pulled/Pushed events) are generated afterward from the app,
///         which already builds taker traits in TypeScript.
/// @dev The seed `ship()` emits a `Shipped` event, so the subgraph has data
///      immediately. Run with:
///      forge script script/SepoliaEnv.s.sol:SepoliaEnv \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaEnv is Script {
    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_DEPLOYER_PK");
        address maker = vm.addr(pk);

        vm.startBroadcast(pk);

        // Testnet tokens: WETH/USDC don't exist at canonical addresses on
        // Sepolia, so deploy mocks. The subgraph indexes Aqua events, not the
        // tokens themselves.
        TokenMockDecimals weth = new TokenMockDecimals("Wrapped Ether", "WETH", 18);
        TokenMockDecimals usdc = new TokenMockDecimals("USD Coin", "USDC", 6);

        Aqua aqua = new Aqua();
        BacalhauRouter router = new BacalhauRouter(address(aqua), address(weth), maker, "SwapVM", "1.0.0");

        // Fund the maker and approve Aqua so ship() can pull on swaps.
        weth.mint(maker, 1_000e18);
        usdc.mint(maker, 2_000_000e6);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);

        ISwapVM.Order memory order =
            SeedOrderLib.selfBalancingOrder(maker, address(weth), address(usdc), SEPOLIA_SEED_SALT);
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SEED_WETH;
        amounts[1] = SEED_USDC;
        bytes32 strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);

        vm.stopBroadcast();

        string memory json = "sepolia";
        vm.serializeAddress(json, "aqua", address(aqua));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeUint(json, "deployBlock", block.number);
        vm.serializeAddress(json, "weth", address(weth));
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeUint(json, "usdcDecimals", 6);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "maker", maker);
        string memory out = vm.serializeBytes32(json, "seedStrategyHash", strategyHash);
        vm.writeJson(out, "deployments/sepolia.json");

        console2.log("aqua  ", address(aqua));
        console2.log("router", address(router));
        console2.log("weth  ", address(weth));
        console2.log("usdc  ", address(usdc));
        console2.log("maker ", maker);
        console2.logBytes32(strategyHash);
    }
}
