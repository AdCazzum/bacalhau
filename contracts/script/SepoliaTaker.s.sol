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
/// @dev Run with:
///      forge script script/SepoliaTaker.s.sol:SepoliaTaker \
///        --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $SEPOLIA_DEPLOYER_PK
contract SepoliaTaker is Script {
    // From deployments/sepolia.json — fixed, already on chain.
    address internal constant AQUA = 0xE5Cf2ec690BeE8b59cB8340f469ecfB2f0De98bD;
    address internal constant ROUTER = 0xF9b0AfdDad9D249Eb22e69b15df2a4E8C1e99ABC;
    address internal constant WETH = 0x0F599727F37D4Fc8AB5dBD3aFe86c3EbF4A892f7;
    address internal constant USDC = 0xB6Ec46C767B71a5AA4b51bad4A40827560D63e55;

    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_DEPLOYER_PK");
        address maker = vm.addr(pk);

        vm.startBroadcast(pk);

        MockTaker taker = new MockTaker(Aqua(payable(AQUA)), SwapVM(payable(ROUTER)), maker);

        // The taker pays tokenIn out of its own balance, so it needs inventory
        // on both sides. Mock tokens, unlimited mint - generous amounts so the
        // demo never stalls on an underfunded counterparty.
        TokenMockDecimals(WETH).mint(address(taker), 10_000e18);
        TokenMockDecimals(USDC).mint(address(taker), 20_000_000e6);

        vm.stopBroadcast();

        console2.log("taker", address(taker));
    }
}
