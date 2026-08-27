# Settings Copy Deck

用法：直接改 `Name` 和 `Desc`，改完告诉我"应用"，我同步进代码。
`Key` 是代码标识，不要动。

分组建议（待你确认）：Chart(1–5) / Daily notes(6–7) / Completion(8) / Highlight(9–10) / Execution layer(11–14)

---

## 1. Workday start

- Key: `workdayStart`
- Type: dropdown 0:00–23:00
- Name: Workday start
- Desc: The day plan starts at this hour. Default: 7:00.
- 中文含义：一天计划的开始时间，任务从这一刻开始排

## 2. Workday end

- Key: `workdayEnd`
- Type: dropdown 1:00–24:00
- Name: Workday end
- Desc: The day plan ends at this hour. An end at or before the start runs into the next day. Default: 22:00.
- 中文含义：一天计划的结束时间；结束 ≤ 开始则跨午夜

## 3. Default task duration

- Key: `defaultDuration`
- Type: slider 5–60
- Name: Default task duration
- Desc: Planned length for tasks without a written duration. Default: 30 min.
- 中文含义：弹性任务的默认时长；写了 30m 的任务不受默认值影响

## 4. Label length limit

- Key: `legendLenLimit`
- Type: slider 15–30
- Name: Label length limit
- Desc: Maximum characters per task name on the chart. One Chinese character counts as two. Default: 22.
- 中文含义：图上任务名最多显示多少字符，超出截断；一个汉字算两个字符

## 5. Show playback button

- Key: `showPlaybackButton`
- Type: toggle
- Name: Show playback button
- Desc: Show a button that replays the day as an animation. Default: on.
- 中文含义：是否显示"回放今日任务动画"按钮

## 6. Daily note name

- Key: `dailyNoteFormat`
- Type: text
- Name: Daily note name
- Desc: The date format in daily note filenames (e.g. YYYY-MM-DD). Default: YYYY-MM-DD.
- Warn: A wrong format means the plugin cannot tell which note is today.
- 中文含义：日记命名规则；填错则插件认不出"今天"，实时指针和从现在排程都不会生效

## 7. Daily notes folder

- Key: `dailyNotesFolder`
- Type: text
- Name: Daily notes folder
- Desc: The folder that stores daily notes (e.g. Daily). Used by the "Locate primary plan" command. Default: empty (vault root).
- 中文含义：日记文件路径；只被 Locate primary plan 命令使用，不影响日记识别

## 8. Record completion time

- Key: `stampOnCheck`
- Type: toggle
- Name: Record completion time
- Desc: Checking off a task adds a completion time (e.g. d14:31). Unchecking removes the timestamp. Default: on.
- Warn: Without a timestamp, a finished task cannot be shown on the chart.
- 中文含义：勾选 TODO 后添加完成时间戳；取消勾选会删除；不加时间戳的任务完成后不会在图上显示

## 9. Highlight tag

- Key: `customColorTag`
- Type: text
- Name: Highlight tag
- Desc: Tasks with the highlight tag use the highlight color (e.g. #focus). Default: empty (off).
- 中文含义：带此标签的任务用高亮色绘制

## 10. Highlight color

- Key: `customColor`
- Type: text（可换取色器控件，待你确认）
- Name: Highlight color
- Desc: The color for tasks with the highlight tag. Default: rgba(255,0,0,0.5).
- 中文含义：高亮色；可改成取色器，不用手写 rgba

## 11. Execution layer

- Key: `executionLayer`
- Type: toggle（本组开关）
- Name: Execution layer
- Desc: CLOCK records, a POMO timer, and a daily review above the chart. Default: off.
- 中文含义：打开后日记的图上方出现 Timing/Plan/Review 面板

## 12. Pomodoro time

- Key: `pomodoroThreshold`
- Type: slider 0–120
- Name: Pomodoro time
- Desc: Minutes before the POMO timer turns red. Default: 25 min.
- 中文含义：POMO 计时超过该分钟数变红

## 13. Show finished tasks for

- Key: `recentRetention`
- Type: slider 0–120
- Name: Show finished tasks for
- Desc: Minutes a stopped task stays in the Timing tab. 0 hides stopped tasks. Default: 45 min.
- 中文含义：任务 Clock out 后在 Timing 页再停留多久；设 0 = 一停就消失；笔记里的记录永远在

## 14. Forgotten timer warning

- Key: `forgottenTimerWarning`
- Type: slider 0–240
- Name: Forgotten timer warning
- Desc: Minutes a CLOCK may run before the elapsed time turns red. 0 disables. Default: 30 min.
- Warn: The warning never stops the CLOCK.
- 中文含义：从 Clock in 起算，连续计时超过该分钟数就变红提醒（和任务估计时长无关）；永不自动停止；设 0 关闭
