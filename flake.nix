{
  description = "Bacalhau — visual liquidity strategy studio (ETHGlobal Lisbon 2026)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    rust-overlay.url = "github:oxalica/rust-overlay";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
  };

  outputs = inputs@{ flake-parts, rust-overlay, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.process-compose-flake.flakeModule ];

      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { system, pkgs, self', ... }:
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

          # `nix run .#dev` is meant to work without entering the devShell, so
          # the processes get an explicit PATH instead of inheriting one.
          demoPath = pkgs.lib.makeBinPath (with pkgs; [
            foundry nodejs_22 pnpm jq bash coreutils gnugrep gnused curl
          ]);

          # The public demo build. Hermetic: pnpm deps are fetched by hash and
          # the build runs offline, so `result` is byte-identical locally and
          # in CI. No secrets are passed in — the Uniswap key lives in the
          # Pages worker (app/public/_worker.js), never in the bundle.
          site = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "bacalhau-site";
            version = "0.1.0";
            src = ./app;

            nativeBuildInputs = [ pkgs.nodejs_22 pkgs.pnpm pkgs.pnpmConfigHook ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 4;
              hash = "sha256-xWx5HudRWUKGHX2wBim4XEDdFys3oQlKq2isPgKxfLY=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            # dist/ already contains _worker.js (copied verbatim from public/),
            # so $out is a self-contained Cloudflare Pages deploy root.
            installPhase = ''
              runHook preInstall
              cp -r dist $out
              runHook postInstall
            '';
          });

          # Impure by nature (network + credentials), so it is an app rather
          # than a package: `nix run .#deploy` uploads the derivation above.
          deploy = pkgs.writeShellApplication {
            name = "bacalhau-deploy";
            runtimeInputs = [ pkgs.wrangler ];
            text = ''
              project="''${CF_PAGES_PROJECT:-bacalhau}"
              branch="''${CF_PAGES_BRANCH:-main}"

              # Keep the worker's key in step with the deploy when one is
              # provided; otherwise leave whatever is already configured.
              if [ -n "''${UNISWAP_API_KEY:-}" ]; then
                echo "$UNISWAP_API_KEY" \
                  | wrangler pages secret put UNISWAP_API_KEY --project-name "$project"
              fi

              wrangler pages deploy ${self'.packages.site} \
                --project-name "$project" \
                --branch "$branch"
            '';
          };
        in {
          _module.args.pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };

          # Single entry point: `nix run .#dev` brings up the whole demo.
          # anvil (Base fork) -> deploy + seed -> vite, wired by readiness so
          # the app never starts before local.json exists.
          process-compose."dev".settings = {
            # Stop vite before the chain it talks to.
            ordered_shutdown = true;
            environment.PATH = "${demoPath}:/usr/bin:/bin";

            processes = {
              anvil = {
                # Silenced: anvil logs every RPC call, which drowns the TUI.
                command = "anvil --fork-url \${BASE_RPC_URL:-https://mainnet.base.org} --block-time 1 --silent";
                readiness_probe = {
                  exec.command = "cast chain-id --rpc-url http://127.0.0.1:8545";
                  initial_delay_seconds = 2;
                  period_seconds = 1;
                  failure_threshold = 60;
                };
              };

              # Deploys Aqua + BacalhauRouter, ships the seed strategy and
              # writes app/public/local.json. Reuses the anvil above rather
              # than starting its own, then exits.
              deploy = {
                command = "./scripts/demo-env.sh";
                depends_on.anvil.condition = "process_healthy";
              };

              app = {
                command = "pnpm install && pnpm dev";
                working_dir = "app";
                depends_on.deploy.condition = "process_completed_successfully";
              };
            };
          };

          packages.site = site;
          packages.deploy = deploy;
          apps.deploy.program = pkgs.lib.getExe deploy;

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              # Contracts (Aqua app + SwapVM custom instruction)
              foundry

              # Frontend + subgraph tooling (graph-cli comes via pnpm)
              nodejs_22
              pnpm

              # Cloudflare Pages deploys (`nix run .#deploy` uses this too)
              wrangler

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
