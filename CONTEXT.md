# Nautilus Log (Obsidian)

Obsidian 插件：把日记里的任务清单渲染成 nautilus 螺旋时间图，并提供可选的执行层（clock 计时、计划/回顾面板）。移植自 Roam 的 roam-nautilus-log。

## Language

### 任务与时间

**todo**:
带 checkbox 的任务项，可有 estimate（预估分钟数）和文本内的时间段。
_Avoid_: task（代码里泛指所有列表行时的遗留叫法）

**planned time（计划时间）**:
任务文本里预设的时间——显式时间段（`10:00-10:30`）或 estimate。属于"打算做"，不是事实。
_Avoid_: fixed time, scheduled time

**done stamp（d 戳）**:
勾选完成时追加在任务行尾的 `dHH:MM` 标记，记录的是"何时点了勾选"，不是"何时做完了工作"。仅作无 clock 时的 fallback 锚点。
_Avoid_: done time, completion time（这两个说法容易让人误以为它代表真实完成时刻）

### Clock（执行层）

**clock**:
任务下缩进子行里的 CLOCK 记录，格式 `- CLOCK: [start]--[end] => h:mm`。新数据不再包裹 `LOGBOOK::`（roam 语法已抛弃）；旧文件里的 LOGBOOK 包裹记录仍可被解析。
_Avoid_: LOGBOOK entry, time log

**closed clock（完整 clock）**:
有 start 和 end 的 clock，是"实际发生了什么"的最高优先级事实。

**open clock**:
只有 start 的 clock，表示正在计时。勾选完成时自动以勾选时刻关闭。

### 渲染优先级

**actual-first（clock 优先）**:
渲染与统计的优先级链：closed clock > open clock（画到 now）> done stamp > estimate。有 clock 时 planned time 和 done stamp 彻底退位；clock end 与勾选时刻之间的 gap 不发明数据、不计入 actual。
