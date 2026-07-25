// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

import { InventorySkew } from "./InventorySkew.sol";
import { InventoryBranch } from "./InventoryBranch.sol";

/// @title BacalhauOpcodes
/// @notice Official Aqua opcode table extended with Bacalhau's InventorySkew
///         and InventoryBranch, appended at the end per the swap-vm
///         backward-compatibility rule.
contract BacalhauOpcodes is AquaOpcodes, InventorySkew, InventoryBranch {
    constructor(address aqua) AquaOpcodes(aqua) {}

    function _opcodes() internal pure virtual override returns (function(Context memory, bytes calldata) internal[] memory result) {
        function(Context memory, bytes calldata) internal[] memory base = super._opcodes();
        result = new function(Context memory, bytes calldata) internal[](base.length + 2);
        for (uint256 i = 0; i < base.length; i++) {
            result[i] = base[i];
        }
        result[base.length] = InventorySkew._inventorySkewXD; // 0x22
        result[base.length + 1] = InventoryBranch._jumpIfInventoryAboveXD; // 0x23
    }
}

/// @title BacalhauRouter
/// @notice AquaSwapVMRouter equivalent built on the extended opcode table.
///         This is the "modified SwapVM redeploy" allowed by the 1inch track.
contract BacalhauRouter is Simulator, SwapVM, BacalhauOpcodes {
    constructor(
        address aqua,
        address weth,
        address owner,
        string memory name,
        string memory version
    ) SwapVM(aqua, weth, owner, name, version) BacalhauOpcodes(aqua) {}

    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory result) {
        return _opcodes();
    }
}
