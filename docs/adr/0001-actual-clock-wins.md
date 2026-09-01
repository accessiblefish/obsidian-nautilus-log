# Actual clock wins over planned time and done stamps

执行层渲染与统计的事实来源定为优先级链：closed clock > open clock（画到 now）> done stamp（`dHH:MM`）> estimate。任务存在完整 clock 时，原先设定的计划时间（文本内时间段 / estimate）和勾选时追加的 d 戳在图上与 review 中彻底退位；d 戳仅在任务完全没有 clock 时作 fallback 锚点。clock end 与勾选时刻之间的 gap 不发明数据、不计入 actual——它既可能是"忘了勾选"的噪声，也可能是"补做但未计时"的工作，数据上不可区分，选择不猜。同时写入侧抛弃 roam 的 `LOGBOOK::` 抽屉，CLOCK 直接作为任务的缩进子行；读取侧继续兼容旧格式。

## Considered Options

- **gap 计入 actual（clock 延伸到勾选时刻）**：放弃。"勾得晚"的常见原因是忘了勾，会把几小时噪声记成工作量。
- **勾选时不写 d 戳**：放弃。d 戳对无 clock 任务仍是必需锚点，且保留"何时勾的"审计信息。

## Consequences

- 勾选完成时若任务挂着 open clock，插件自动以勾选时刻关闭它（done 语义即工作停止）。
- 图上每段完整 clock 各画一条弧（点状纹理），计划弧与实际弧可同时存在；open clock 画一条到 now 的实时弧。
