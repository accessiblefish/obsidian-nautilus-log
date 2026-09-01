# Nautilus Log — 使用指南

[返回 README](../README.md) · [English](./guide.md)

## 执行层（Execution Layer）

执行层在"时间规划"之上加了"时间追踪"。**默认关闭**——在 设置 → Nautilus Log → **Execution layer** 打开。

打开后，今天日记里的第一个 nautilus 代码块成为**主计划（Primary Plan）**，螺旋图上方出现执行面板，三个标签页：**Timing**、**Plan**、**Review**。

```
┌────────────────────────────────────────────┐
│ [Timing] [Plan] [Review]          POMO ▶   │
├────────────────────────────────────────────┤
│ ● 写周报                    0:12  [Clock out] │
│ 晨跑 · 0:30                                 │
└────────────────────────────────────────────┘
```

---

## CLOCK —— 记录实际时间

Clock in 会在笔记里、任务正下方写入一条记录（不再有 `LOGBOOK::` 抽屉）：

```markdown
- [ ] 写周报 45m
  - CLOCK: [2026-08-26 Wed 14:00]
```

Clock out（或切到别的任务）会闭合这条记录：

```markdown
  - CLOCK: [2026-08-26 Wed 14:00]--[2026-08-26 Wed 14:18] => 0:18
```

每段闭合的 CLOCK 会在螺旋上按真实位置各画一条弧（点状纹理）；进行中的 CLOCK 画一条延伸到此刻的实时弧。图上与回顾中 CLOCK 优先于任务预设的时间和完成戳（见 `docs/adr/0001`）。旧版 `LOGBOOK::` 包裹的记录仍能正常读取。

规则：

- **同时只有一个 CLOCK。** 开始新任务的 CLOCK 会在同一时刻关闭上一个。
- **笔记即状态。** 进行中的 CLOCK 就是文件里一条未闭合的记录——重启 Obsidian 自动恢复。
- **遗忘警告。** CLOCK 运行超过阈值（默认 120 分钟）后耗时变红提醒你，但绝不替你停止或删除。设为 `0` 关闭。
- **跨午夜窗口。** 午夜后的 CLOCK 时间仍归属窗口所属的日记，直到窗口结束。

开始/结束计时的方式：

- **Plan 页** → 任务旁的 Clock in 按钮
- **Timing 页** → 进行中任务的 Clock out
- 命令面板 → **Clock in/out task on current line**（光标停在任务行上）
- 命令面板 → **Clock out current task**

### CLOCK 数据如何影响螺旋图

有 CLOCK 记录的任务画在螺旋上**实际发生的位置**：

- 每段闭合的 CLOCK 按真实时间段各画一条弧（点状纹理）——多段计时就是多条弧；进行中的 CLOCK 画一条延伸到此刻的实时弧
- 实际弧优先于任务预设的时间和 `dHH:MM` 完成戳；最后一段 CLOCK 结束与勾选之间的间隔不计入
- 勾选完成的任务若还挂着计时，会在勾选时刻自动闭合
- 完全没有 CLOCK 的已完成任务才回退到旧行为：按估计时长画在 `dHH:MM` 时间戳锚定的位置；没有时间戳则不虚构历史——任务不出现在图上

## POMO —— 独立专注计时

面板头部的 **POMO** 按钮启动一个简单的正计时器。

- 不写笔记，不影响 Actual、Planned、Review 和螺旋图
- 重启 Obsidian 后仍在走
- 开始任务 CLOCK 时自动清除——正式 CLOCK 永远优先
- 超过番茄阈值（默认 45 分钟）变红，提醒该休息了，但不会停止

## Review —— 计划与实际对比

**Review** 页逐任务对比估计与现实：

| 任务 | Planned | Actual | ± |
|---|---|---|---|
| 写周报 | 45m | 40m | -5m |
| 晨跑 | 30m | — | — |

任务状态：

| 状态 | 含义 |
|---|---|
| compared | 已完成且有 CLOCK 数据——显示差异 |
| not-tracked | 已完成但无 CLOCK 数据——无从对比 |
| live | CLOCK 正在运行 |
| paused | 有 CLOCK 记录，未运行，未完成 |
| not-started | 还没有任何 CLOCK 记录 |

汇总行统计所有有追踪记录的任务（compared、live、paused）——把估计和从未追踪过的现实对比没有意义。Actual 不会被 Planned 截断：30 分钟的任务真做了 2 小时，就报 +1h30m。

## 设置项

| 设置 | 默认 | 含义 |
|---|---|---|
| Execution layer | 关 | 面板、CLOCK 写入、命令的总开关 |
| Pomodoro threshold | 45 分钟 | POMO 超过后变红 |
| Recent retention | 45 分钟 | 已关闭的 CLOCK 在 Timing 页保留多久；`0` 关闭 |
| Forgotten timer warning | 120 分钟 | CLOCK 运行超时提醒；`0` 关闭 |

## 命令

- **Clock in/out task on current line** —— 建议绑快捷键，最快的操作路径
- **Clock out current task**
- **Locate primary plan** —— 跳到今天的日记
