{
  description = "Bacalhau — visual liquidity strategy studio (ETHGlobal Lisbon 2026)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Contracts (Aqua app + SwapVM custom instruction)
            foundry

            # Frontend + subgraph tooling (graph-cli comes via pnpm, it is not in nixpkgs)
            nodejs_22
            pnpm

            # Substreams module (Rust -> wasm) + protobuf codegen
            rustc
            cargo
            rustfmt
            clippy
            protobuf

            # Utilities
            jq
          ];

          shellHook = ''
            # TODO: substreams CLI is not in nixpkgs; add a fetchurl derivation
            # from https://github.com/streamingfast/substreams/releases when the
            # indexer work starts.
            echo "bacalhau devshell — forge $(forge --version 2>/dev/null | head -1 || echo 'not warmed yet')"
          '';
        };
      };
    };
}
