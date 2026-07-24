{
  description = "Bacalhau — visual liquidity strategy studio (ETHGlobal Lisbon 2026)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = inputs@{ flake-parts, rust-overlay, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { system, pkgs, ... }:
        let
          rustToolchain = pkgs.rust-bin.stable.latest.default.override {
            targets = [ "wasm32-unknown-unknown" ];
          };

          # Substreams CLI is not in nixpkgs; pin the official release binary.
          substreamsVersion = "1.20.2";
          substreamsAssets = {
            aarch64-darwin = {
              file = "substreams_darwin_arm64.tar.gz";
              hash = "sha256-9jlEHwjWO/do9qxQdoN5vvTmOQobalCYNTrlRreBz8c=";
            };
            x86_64-darwin = {
              file = "substreams_darwin_x86_64.tar.gz";
              hash = "sha256-BWQ24WQEzoIzTAX8g1GadWxj++VJeR43XMidJNIw20c=";
            };
            aarch64-linux = {
              file = "substreams_linux_arm64.tar.gz";
              hash = "sha256-ywMYZzADjkqq9e9CZhivOYu86iUf/VLQyxAalh/XSKc=";
            };
            x86_64-linux = {
              file = "substreams_linux_x86_64.tar.gz";
              hash = "sha256-6U4QEj3H0c/3YmklBqAMjkVHhu976StFKDhkPqbXlgI=";
            };
          };
          substreamsAsset = substreamsAssets.${system};
          substreams = pkgs.stdenvNoCC.mkDerivation {
            pname = "substreams";
            version = substreamsVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/streamingfast/substreams/releases/download/v${substreamsVersion}/${substreamsAsset.file}";
              inherit (substreamsAsset) hash;
            };
            sourceRoot = ".";
            nativeBuildInputs = pkgs.lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;
            installPhase = ''
              install -Dm755 substreams $out/bin/substreams
            '';
          };
        in {
          _module.args.pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              # Contracts (Aqua app + SwapVM custom instruction)
              foundry

              # Frontend + subgraph tooling (graph-cli comes via pnpm)
              nodejs_22
              pnpm

              # Substreams module (Rust -> wasm) + protobuf codegen + CLI
              rustToolchain
              protobuf
              substreams

              # Utilities
              jq
            ];

            shellHook = ''
              echo "bacalhau devshell — forge $(forge --version 2>/dev/null | head -1 || echo 'not warmed yet') · substreams $(substreams --version 2>/dev/null | head -1 || echo '?')"
            '';
          };
        };
    };
}
