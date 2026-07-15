{
  description = "EktosWhispr – privacy-first voice dictation, meeting transcription & notes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          ektoswhispr = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = ektoswhispr;
          ektoswhispr = ektoswhispr;
        }
      );

      overlays.default = _final: _prev: {
        ektoswhispr = self.packages.x86_64-linux.ektoswhispr;
      };

      nixosModules.default = import ./nix/module.nix self;
    };
}
