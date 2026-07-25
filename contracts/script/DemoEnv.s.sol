// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MockTaker } from "@1inch/swap-vm/test/mocks/MockTaker.sol";

import { BacalhauRouter } from "../src/BacalhauRouter.sol";
import { SeedOrderLib, SEED_WETH, SEED_USDC, DEMO_SEED_SALT } from "./SeedOrder.sol";

interface IERC20Meta {
    function approve(address, uint256) external returns (bool);
}

/// @notice Self-contained deployer. Everything happens in the constructor so
///         forge's broadcast collector sees a single argument-less creation
///         (`new DemoDeployer()`), sidestepping the constructor-args decode
///         bug it hits on BacalhauRouter's inherited constructor.
/// @dev ship() only records virtual balances (no token transfer), so this
///      works before the maker is funded; the wrapper funds maker+taker
///      afterwards via cast for the seed swap.
contract DemoDeployer {
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    Aqua public immutable aqua;
    BacalhauRouter public immutable router;
    MockTaker public immutable taker;
    bytes32 public immutable seedStrategyHash;

    constructor(address maker) {
        aqua = new Aqua();
        router = new BacalhauRouter(address(aqua), BASE_WETH, maker, "SwapVM", "1.0.0");
        taker = new MockTaker(aqua, router, maker);

        ISwapVM.Order memory order = _selfBalancingOrder(maker);
        address[] memory tokens = new address[](2);
        tokens[0] = BASE_WETH;
        tokens[1] = BASE_USDC;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SEED_WETH;
        amounts[1] = SEED_USDC;

        // Maker must have approved Aqua from their own EOA; ship() is called
        // by the maker via the wrapper, not here. Instead we expose the order
        // and let the wrapper ship it. But ship() records under msg.sender as
        // maker, so it must originate from the maker EOA -> done in wrapper.
        seedStrategyHash = router.hash(order);
    }

    function selfBalancingOrder(address maker) external pure returns (ISwapVM.Order memory) {
        return _selfBalancingOrder(maker);
    }

    function _selfBalancingOrder(address maker) internal pure returns (ISwapVM.Order memory) {
        return SeedOrderLib.selfBalancingOrder(maker, BASE_WETH, BASE_USDC, DEMO_SEED_SALT);
    }
}

/// @title DemoEnv
/// @notice Deploys the demo factory, ships the seed strategy from the maker
///         EOA, and writes addresses to deployments/local.json. Run against
///         `anvil --fork-url <Base RPC>`; the wrapper funds balances and runs
///         the seed fill via cast.
contract DemoEnv is Script {
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address maker = vm.addr(pk);

        vm.startBroadcast(pk);
        DemoDeployer deployer = new DemoDeployer(maker);

        Aqua aqua = deployer.aqua();
        BacalhauRouter router = deployer.router();

        IERC20Meta(BASE_WETH).approve(address(aqua), type(uint256).max);
        IERC20Meta(BASE_USDC).approve(address(aqua), type(uint256).max);

        ISwapVM.Order memory order = deployer.selfBalancingOrder(maker);
        address[] memory tokens = new address[](2);
        tokens[0] = BASE_WETH;
        tokens[1] = BASE_USDC;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e18;
        amounts[1] = 200_000e6;
        bytes32 strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.stopBroadcast();

        string memory json = "deployment";
        vm.serializeAddress(json, "aqua", address(aqua));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeUint(json, "deployBlock", block.number);
        vm.serializeAddress(json, "weth", BASE_WETH);
        vm.serializeAddress(json, "usdc", BASE_USDC);
        vm.serializeUint(json, "usdcDecimals", 6);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "maker", maker);
        vm.serializeAddress(json, "taker", address(deployer.taker()));
        string memory out = vm.serializeBytes32(json, "seedStrategyHash", strategyHash);
        vm.writeJson(out, "deployments/local.json");

        console2.log("aqua  ", address(aqua));
        console2.log("router", address(router));
        console2.log("taker ", address(deployer.taker()));
        console2.logBytes32(strategyHash);
    }
}
