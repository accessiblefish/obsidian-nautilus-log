import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,cts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // 测试脚本运行在 Node 环境，允许 console 输出
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "dist/**",
      "esbuild.config.mjs",
      "version-bump.mjs",
    ],
  },
];
