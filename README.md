# Nautilus Log

Your whole day on one spiral — a living day planner for Obsidian.

## Why

Todo lists tell you *what* to do, but not *when* — and the moment your plan slips, the list goes stale and you replan in your head all day.

Nautilus Log draws your day as a spiral timeline:

- **Fixed events** (meetings, lunch) are pinned to their time slots.
- **Flexible tasks** automatically fill the gaps between them.
- **A red "now" pointer** sweeps the dial and pushes unfinished tasks forward, so the plan is always current — you never replan by hand.
- **Done tasks stay visible** on the spiral at the time you actually finished them, so the day becomes a log, not just a plan.

The shrinking spiral mirrors your energy through the day: big loops in the morning, tight loops at night.

## What it looks like

A daily note like this:

    ```nautilus
    ```

    - 09:00-09:30 Standup
    - 12:30-14:00 Lunch
    - [ ] Write weekly report 45m
    - [ ] Reply to emails
    - [x] Morning run 30m

…renders as a spiral: standup and lunch anchored at their hours, the report and emails placed in the free gaps, and the morning run shown where it was actually done.

## How to use

1. Add a ```` ```nautilus ```` code block to your daily note.
2. List your tasks directly below the block. That's it.

Writing tasks:

- **Fixed event**: give it a time range — `09:00-09:30 Standup`
- **Flexible task**: just write it, optionally with a duration — `Write report 45m` or `1h` (default duration in settings)
- **Order matters**: a task listed below an event starts after that event ends
- **Check off as usual** (`- [x]`). The plugin stamps the completion time automatically, so the task appears on the spiral where you finished it. Unchecking removes the stamp. (You can turn this off in settings.)

On the chart:

- **Click a task** on the spiral to add +10% progress — at 100% it's checked off for you.
- **Eye button** (top right): hide/show finished tasks.
- **Play button**: watch a 6-second replay of your whole day.

Settings let you change the workday start (4:00–12:00), default task duration, label length, and the highlight tag — or override them per block:

    ```nautilus
    start: 7
    duration: 20
    len: 25
    tag: #focus
    ```

## Installation

**Community plugins** (once accepted): Settings → Community plugins → Browse → search "Nautilus Log".

**BRAT**: install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then add this repository as a beta plugin.

**Manual**: download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/nautilus-log/`, then enable the plugin.

## Credits

This is a port of the **Nautilus** extension for Roam Research, originally created by [Tomas Barys](https://github.com/tombarys/roam-depot-nautilus), with enhancements from [hopeserena's fork](https://github.com/hopeserena/nautilus-enhanced). All credit for the concept and design goes to them. MIT licensed.

---

## 中文简介

把一整天画在一枚鹦鹉螺上：固定日程钉在表盘上，弹性待办自动填进空档，红色"现在"指针推着未完成的任务往前走——计划永远是新的，不用手动重排。完成的任务会留在实际完成的位置，一天结束，计划即日志。

用法：在日记里插入 ```` ```nautilus ```` 代码块，下方列出任务即可。`09:00-09:30 站会` 是固定日程，`写周报 45m` 是弹性待办。点击图上的任务 +10% 进度，勾选任务自动打完成时间戳。
