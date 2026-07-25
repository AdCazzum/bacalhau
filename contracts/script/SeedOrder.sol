// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { InventorySkewArgsBuilder } from "../src/InventorySkew.sol";

/// @dev Opcodes of the deployed BacalhauRouter table (34 stock Aqua + 2 custom).
uint8 constant OP_XYC_SWAP = 0x11;
uint8 constant OP_SALT = 0x14;
uint8 constant OP_FLAT_FEE_IN = 0x15;
uint8 constant OP_INVENTORY_SKEW = 0x22;

/// @dev Seed strategy parameters shared by every environment script.
uint32 constant FEE_030 = uint32(3 * uint256(BPS) / 1000);
uint32 constant MAX_SKEW = uint32(uint256(BPS) / 20);
uint128 constant SEED_WETH = 100e18;
uint128 constant SEED_USDC = 200_000e6;

/// @dev Per-environment salts: the only byte that differs between the shipped
///      seed orders, and the input that keys each strategy hash.
bytes32 constant DEMO_SEED_SALT = keccak256("bacalhau.demo.seed.v1");
bytes32 constant SEPOLIA_SEED_SALT = keccak256("bacalhau.sepolia.seed.v1");

/// @title SeedOrderLib
/// @notice The one place that knows how to assemble the self-balancing seed
///         order. DemoEnv and SepoliaEnv ship it; SepoliaSwaps reconstructs
///         it byte-for-byte to recover the deployed order hash. Any drift
///         between copies would silently break that reconstruction, so there
///         are no copies.
library SeedOrderLib {
    function selfBalancingOrder(
        address maker,
        address weth,
        address usdc,
        bytes32 salt
    ) internal pure returns (ISwapVM.Order memory) {
        (uint128 t0, uint128 t1) = weth < usdc ? (SEED_WETH, SEED_USDC) : (SEED_USDC, SEED_WETH);
        bytes memory skewArgs = InventorySkewArgsBuilder.build(t0, t1, MAX_SKEW);
        bytes memory program = bytes.concat(
            abi.encodePacked(OP_INVENTORY_SKEW, uint8(skewArgs.length), skewArgs),
            abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), FEE_030),
            abi.encodePacked(OP_XYC_SWAP, uint8(0)),
            abi.encodePacked(OP_SALT, uint8(32), salt)
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
