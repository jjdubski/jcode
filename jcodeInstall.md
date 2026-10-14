# How to install jcode

```bash
bun install
cd packages/cli
bun run script/build.ts --single
```

Run these commands from the repository root. The v2 CLI now lives in `packages/cli`; `packages/opencode` is no longer used.
The `packages/cli/bin/jcode.cjs` launcher selects the locally built binary for your platform.

## Add jcode to your shell (run from repo root)

```bash
echo "alias jcode='node \"$(pwd)/packages/cli/bin/jcode.cjs\"'" >> ~/.zshrc
source ~/.zshrc
```

For bash, replace `~/.zshrc` with `~/.bashrc`.

## Now you can use jcode in any project

---

## Troubleshooting

Make sure to rebuild the binary after updating the source code.

From the repo root:

```bash
cd packages/cli
bun run script/build.ts --single
```
