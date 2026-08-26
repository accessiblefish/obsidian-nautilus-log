# Obsidian Nautilus Log
> 为 Obsidian 移植的可视化时间块日程规划插件，移植自 Roam Research 的 [404KSG/roam-nautilus-log](https://github.com/404KSG/roam-nautilus-log)。

灵感来自 YNAB 的核心理念"给每一块钱一个任务"，本插件把它应用到时间管理上：**给每一分钟一个任务**。

![概览](https://raw.githubusercontent.com/accessiblefish/obsidian-nautilus-log/main/docs/assets/overview.png)

## 核心特性
### 继承的核心理念
- **计划贴合时间**：一眼看到计划总量、可用时间、固定日程、剩余容量，以及今天排不下的任务。
- **透明灵活的调度**：固定日程钉在时间上不动；未完成的任务按列表顺序自然向后推。
- **作息随你**：一天可以从任意整点开始，跨午夜延续到第二天。
- **低摩擦执行**：只写估计时长即可；也可以用独立的 POMO 番茄钟，或用兼容的 LOGBOOK:: / CLOCK: 记录手动计时。
- **有用的每日复盘**：不离开 markdown 笔记，直接对比计划时长与实际时长。

## Obsidian 原生增强
相比 Roam 原版，本移植带来了原生的 Obsidian 工作流与体验改进：

- **Markdown 原生解析**：使用 Obsidian 原生列表语法（`- [ ]`），而非 Roam 内部块语法。
- **内置完成时间戳**：勾选完成任务时自动追加完成时间戳（如 `d08:47`），轻松追踪。

执行层（CLOCK 计时、POMO、每日复盘）、设置与命令详见[使用指南](./docs/guide.zh-CN.md)。

## 快速上手
### 安装
- **BRAT**：在 BRAT 设置中添加 `accessiblefish/obsidian-nautilus-log`。
- **手动**：从 Releases 页面下载最新版本，将 `main.js`、`manifest.json`、`styles.css` 放入库目录的 `.obsidian/plugins/obsidian-nautilus-log/` 文件夹。

### 使用
打开今天的日记。插件按文件名识别日记（默认 `YYYY-MM-DD`）；格式不同的话，在插件设置里修改 **Daily note date format**。

插入一个 Nautilus 代码块：

````Markdown
```nautilus
```

- 07:00-07:30 早餐
- [x] 读书 30min d08:47
- 11:30-12:00 午餐
- [ ] 复盘 30min
- [ ] 健身 40min
````

把固定日程和任务直接写在代码块下方。写上简单的估计时长（如 `30min`、`45m`、`1h30m`）；没写时长的任务使用设置里的默认时长。

> **注意**：本插件会修改你的笔记。勾选代码块下方的任务时，会向该行追加 `dHH:MM` 完成时间戳；取消勾选则移除。这是插件唯一的写操作，可在设置中关闭（"Stamp completion time"）。

## 致谢
- 原创概念与 Roam 插件：[Nautilus](https://github.com/tombarys/roam-depot-nautilus)，作者 Tomáš Barys。
- 增强分支：[Nautilus Enhanced](https://github.com/hopeserena/nautilus-enhanced)，作者 hopeserena。
- 直接移植对象：[roam-nautilus-log](https://github.com/404KSG/roam-nautilus-log)，作者 404KSG。
- Obsidian 移植：为 Obsidian 重新架构并维护。

## 许可证
[MIT License](./LICENSE)
