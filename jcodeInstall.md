# How to install jcode

```bash
cd packages/opencode
bun install
bun run script/build.ts --single
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).
The built binary will be at `packages/opencode/dist/opencode-<platform>/bin/jcode`.

## Add jcode to your shell (run from repo root)

```bash
echo 'alias jcode="'$(pwd)'/packages/opencode/dist/jcode-darwin-arm64/bin/jcode"' >> ~/.zshrc && source ~/.zshrc
```

For bash, replace `~/.zshrc` with `~/.bashrc`.

## Now you can use jcode in any project

---

## Troubleshooting

Make sure to rebuild the binary after updating the source code.

From the repo root:

```bash
cd packages/opencode
bun run script/build.ts --single
```
