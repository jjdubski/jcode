<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <img width="191" height="60" alt="jcode logo" src="https://github.com/user-attachments/assets/570ade87-f7ab-47dd-9f4d-11c0e29afb70" />
    </picture>
  </a>
</p>
<p align="center">An open source AI coding agent (forked from opencode with some customizations).</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

Clone the repo then follow:
<a href="jcodeInstall.md">Install README</a>

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to jcode, please submit a pull request!

**Not built by the OpenCode team and is not affiliated with OpenCode parent company in any way.**
