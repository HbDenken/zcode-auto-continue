---
description: 查看自动续跑（auto-continue）守护进程状态与当日统计
argument-hint: [status|stats|pause [时长]|resume|skip-once]
---

用户执行了 `/auto-continue` 命令。参数为：`$ARGUMENTS`。

请帮助用户检查或管理 `zcode-auto-continue` 插件。

注意：`pause` / `resume` / `skip-once` 三个子命令已由插件的 UserPromptSubmit 钩子直接拦截并写入状态
（`pausedUntil`、`suppress`），无需再手工改文件；此处只需向用户确认结果。

1. **若参数为空或包含 `status`**：
   - 检查守护进程状态：查看进程 `~/.zcode/auto-continue/watcher.pid` 是否存活
     （PowerShell：`Get-Process -Id (Get-Content "$env:USERPROFILE\.zcode\auto-continue\watcher.pid") -ErrorAction SilentlyContinue`）；
   - 若未运行：说明 SessionStart 钩子会在下次会话自动拉起；也可手动启动
     `<插件根>/lib/watcher.mjs`（路径以插件实际安装位置为准，不要硬编码盘符）；
   - 读取并汇总当日统计：`~/.zcode/auto-continue/stats-<今日日期>.json`。

2. **若包含 `stats`**：
   - 读取并结构化展示：`~/.zcode/auto-continue/stats-*.json`（sent 发送 / skipped 跳过 / recovered 恢复成功 / gaveUp 达到上限放弃 / byCode 错误码分布）。

3. **若包含 `pause`**：
   - 钩子已写状态：带时长（如 `10m`）写入 `state.json` 的 `pausedUntil`（到期自动恢复），
     不带时长写入 `config.json` 的 `"paused": true`。请读取这两个文件确认并告知用户生效方式。

4. **若包含 `resume`**：
   - 钩子已清除 `pausedUntil` 并把 `config.json` 的 `"paused"` 置为 `false`。读取确认即可。

5. **若包含 `skip-once`**：
   - 钩子已在 `state.json` 的 `suppress` 写入一次性豁免：当前会话本轮结束后不自动续跑，消费后自动清除。
