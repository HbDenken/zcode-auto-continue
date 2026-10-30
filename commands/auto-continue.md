---
description: 查看自动续跑（auto-continue）守护进程状态与当日统计
argument-hint: [status|stats|pause|resume]
---

用户执行了 `/auto-continue` 命令。参数为：`$ARGUMENTS`。

请帮助用户检查或管理 `zcode-auto-continue` 插件：

1. **若参数为空或包含 `status`**：
   - 检查守护进程状态：查看进程 `~/.zcode/auto-continue/watcher.pid` 是否存活（在 PowerShell 运行 `Get-Process -Id (Get-Content "$env:USERPROFILE\.zcode\auto-continue\watcher.pid") -ErrorAction SilentlyContinue`）；
   - 若未运行，告知启动命令：`node "K:\zcode\auto-continue\zcode-auto-continue\lib\watcher.mjs"`；
   - 读取并汇总当日统计：`~/.zcode/auto-continue/stats-<今日日期>.json`。

2. **若包含 `stats`**：
   - 读取并结构化展示：`~/.zcode/auto-continue/stats-*.json` 中的历史统计（sent 发送数 / skipped 跳过数 / recovered 恢复成功数 / gaveUp 达到上限放弃数 / byCode 错误码分布）。

3. **若包含 `pause`**：
   - 编辑 `~/.zcode/auto-continue/config.json`，将 `"paused": true`。

4. **若包含 `resume`**：
   - 编辑 `~/.zcode/auto-continue/config.json`，将 `"paused": false`。
