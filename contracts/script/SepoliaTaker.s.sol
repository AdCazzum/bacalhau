// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { MockTaker } from "@1inch/swap-vm/test/mocks/MockTaker.sol";
import { TokenMockDecimals } from "@1inch/swap-vm/test/mocks/TokenMockDecimals.sol";

/// @title SepoliaTaker
/// @notice Adds the missing piece for a fully interactive public demo: the
///         taker contract the test-swap panel drives. SepoliaEnv deployed
///         Aqua/router/tokens but no taker, because fills were meant to be
///         generated once from a script; letting visitors execute them from
///         the deployed site needs the counterparty on chain and funded.
/// @dev Reads deployed addresses from deployments/sepolia.json. Run with:
///      forge script script/SepoliaTaker.s.sol:SepoliaTaker \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaTaker is Script {
    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_DEPLOYER_PK");
        address maker = vm.addr(pk);

        string memory dep = vm.readFile("deployments/sepolia.json");
        Aqua aqua = Aqua(vm.parseJsonAddress(dep, ".aqua"));
        SwapVM router = SwapVM(payable(vm.parseJsonAddress(dep, ".router")));
        TokenMockDecimals weth = TokenMockDecimals(vm.parseJsonAddress(dep, ".weth"));
        TokenMockDecimals usdc = TokenMockDecimals(vm.parseJsonAddress(dep, ".usdc"));

        vm.startBroadcast(pk);

        MockTaker taker = new MockTaker(aqua, router, maker);

        // The taker pays tokenIn out of its own balance, so it needs inventory
        // on both sides. Mock tokens, unlimited mint - generous amounts so the
        // demo never stalls on an underfunded counterparty.
        weth.mint(address(taker), 10_000e18);
        usdc.mint(address(taker), 20_000_000e6);

        vm.stopBroadcast();

        console2.log("taker", address(taker));
    }
}
