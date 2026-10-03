# AGENTS.md

**除非用户明确要求发布新版本，否则严禁主动提出或执行任何发布相关操作。**

具体禁止行为：
- 提出发布请求
- 禁止修改 `package.json`、`manifest.json`、`versions.json` 中的版本号（包括运行 `npm version`、`npm run version` 或 `version-bump.mjs`）
- 禁止创建或推送 git tag
- 禁止执行 `gh release create` 等任何创建 GitHub Release 的命令

## 发布流程（仅在用户明确要求时执行）

发布由 CI 完成：`.github/workflows/release.yml` 在 tag 推送时自动 build 并创建 GitHub Release（含 provenance attestation）。**不要手动 `gh release create`**——它会与 CI 撞车，报 "a release with the same tag name already exists"。

正确步骤：

1. 确认 `npm test` 全部通过、`npm run build` 成功、工作区无未提交改动。
2. `npm version x.y.z`——自动同步 `package.json` / `manifest.json` / `versions.json` 并创建 commit 和 tag（tag 无 `v` 前缀）。
3. `git push origin main --follow-tags`。
4. 用 `gh run list` 确认 Release workflow 成功；release 由 CI 创建，标题为 tag 名，notes 自动生成。
