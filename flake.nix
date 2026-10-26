# log-skimmer-web devShell — 提供可复现的本地工具链运行时。
# 工具链版本 SSOT 说明: node 运行时由本 flake 锁定 (nixpkgs input);
# JS 侧工具 (biome/typescript/esbuild/playwright) 的版本 SSOT = package-lock.json
# (npm ci 精确复现) — 单一版本平面, 避免 nix/npm 双源漂移。
# Playwright 浏览器: `npx playwright install chromium` (或复用 ~/.cache/ms-playwright 既有缓存)。
{
  description = "log-skimmer-web — browser userscript delivery for log-skimmer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "log-skimmer-web";
          packages = with pkgs; [
            nodejs_24
            just
            jq
            ripgrep
          ];
          shellHook = ''
            echo "[log-skimmer-web] node $(node --version) — run 'just install' once, then 'just check'."
          '';
        };
      }
    );
}
