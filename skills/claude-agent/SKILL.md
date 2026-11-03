---
name: claude-agent
description: >-
  Use when the user asks Claude Code to implement, refactor, review or inspect
  work, or when a task benefits from Claude's coding ability. Dispatch tracked
  Claude Code tasks with an explicit model (opus/sonnet/haiku), verify the result
  on disk, then report and acknowledge with the dispatching Bot's owner ID.
---
# 把工作派給 Claude Code（claude-task）

Claude Code 是 Bot 同一台電腦上的另一個 CLI coding agent，不是使用者的筆電。
派工入口是 `~/tools/pi-call/claude-task`，任務資料存在
`~/.claude-tasks/<ID>/`（可用 `CLAUDE_TASK_DIR` 覆寫）。安裝與登入見來源
repo 的 `docs/setup-guide.md`，完整指令見 `docs/claude-task-reference.md`。

和使用者對話、回報時使用使用者偏好的語言，不要因為本技能是中文就強制中文回覆。

## 何時派給 Claude Code

適合：
- 需要跨檔案推理的實作、重構、除錯。
- 一般程式、腳本、測試與文件撰寫。
- 明確要求 Claude Code 或第二個模型意見的工作。
- 批次檔案處理、格式轉換與小型自動化。

留在 Bot：
- 簡短問答、輕量對話。
- Gmail、X、GitHub 等連接器操作；Claude Code 不會繼承 Bot 的連接器。
- 對外發送、發布、push、部署前的授權與最終回報。

## 模型規則（一律明確指定）

`run` 的 `--model` 是必填，不能省略，也不要依賴 Claude Code 的互動式預設：

| 模型 | 使用時機 |
| --- | --- |
| `opus` | 複雜重構、跨檔案推理、高難度除錯、需要較強判斷的長任務 |
| `sonnet` | 中等難度：一般實作、文件、常見修改、日常主力 |
| `haiku` | 小改動：格式整理、簡單轉換、低風險批次處理 |

也可使用 `claude-` 開頭的完整模型名（例如 `claude-sonnet-4-5`）。不要傳
`gpt`、`deepseek/...` 或其他供應商名稱，會直接被 usage error 拒絕。
`reply` 預設沿用原任務的 model，需要時才用 `reply --model` 覆寫。

## 工作流程

1. 選一個短英文 kebab-case session 名稱；同一 session 同時只能有一個執行中的任務。
   選定一個已存在的專案資料夾作為 cwd（必須是資料夾，否則 `run` 會拒絕），
   Claude Code 就在該目錄執行；任務紀錄仍寫在 `~/.claude-tasks/<ID>/`。
   prompt 中要給清楚的目標、輸入路徑、輸出檔名與驗收條件。
2. 寫一個自包含的 prompt。Claude Code 看不到 Bot 的對話；請包含背景、限制、
   要修改／建立的檔案、輸出位置，以及「完成後列出變更與簡短結論」。
3. 用 Bot Shell 工具自帶的背景模式啟動（不要用 nohup、`&`、setsid）：

   ```text
   ~/tools/pi-call/claude-task run <cwd> "<prompt>" --session <name> --model <opus|sonnet|haiku> --owner YOUR_AGENT_ID [--timeout sec] [--no-write] [--no-web]
   ```

   一律帶 `--owner`。owner 是派工 Bot 的 agent ID，例如
   `/home/box/agent-data/agents/YOUR_AGENT_ID/profile.json`；也可以用
   `CLAUDE_TASK_OWNER` 作 fallback，但明確傳旗標更安全。沒有 owner 時，
   自動路由無法辨識派工者。
4. 記下 stdout 第一行 `TASK <ID>`。完成時會印出 `STATE` 與 `RESULT`。
   退出碼：0 done、1 failed／拒絕、2 usage error、124 timeout、130 cancelled。
5. 查詢與處理：
   - `status ID`：狀態、owner、model、Claude session、時間、options、最近事件。
     需要 exit_code 時直接讀 `status.json`。
   - `list [--all] [--owner ID|none]`：running 與近期任務。
   - `cancel ID`：終止 runner 與整個 Claude process group。
   - `pending [--owner ID|none]`：已結束但尚未回報的任務。
   - `ack ID --owner ID`：標記已回報；owner 不符會被拒絕。
6. 驗證再回報：Claude 的 assistant 回覆只是說法，不是證據。讀
   `~/.claude-tasks/ID/result.md`，必要時檢查 `claude.jsonl`、`events.jsonl`、
   產出的檔案、diff 或測試。向使用者報告 ID、狀態、結論、驗證證據與產物路徑，
   再執行 `ack ID --owner YOUR_AGENT_ID`。驗證失敗時保留 pending 並說明卡點。
7. 後續修改用 `reply ID "<changes>"`。它保留原 owner、`status.cwd` 與 options，
   並以 `--resume <claude_session_id>` 接續同一個 Claude session；執行中的任務
   會拒絕 reply。需要不同模型時才加 `--model`。

## 權限與安全

- 預設使用 `--permission-mode acceptEdits`。需要唯讀／規劃時加 `--no-write`
  （Claude 會用 `plan`）；需要停用網路時加 `--no-web`
  （`--disallowedTools WebFetch WebSearch`）。這些是工具設定，不是硬體沙箱。
- **絕對不要**讀取、列出、複製或輸出 `~/.claude/` 下的任何檔案、session、
  token 或認證資料。Claude Code 的登入與憑證由使用者自己處理。
- 金鑰只透過宿主的安全輸入／環境變數提供（例如 `ANTHROPIC_API_KEY`），不要
  寫入檔案、prompt、repo 或命令列參數，也不要在對話中貼出。
- 不要讓 Claude Code 檢查環境變數中的 secret、`PI_NOTIFY_SECRET`、
  `TELEGRAM_BOT_TOKEN`、`CLOUDFLARE_API_TOKEN`。派工入口已把這些變數從子程序
  環境移除，但 prompt 仍不應要求它尋找憑證。
- 不要派工：push、部署、DNS／正式環境變更、對外發訊息或 email、刪除重要檔案。
  這些由 Bot 在使用者明確授權後處理。
- 絕不 ack 其他 Bot 的任務。Bot 使用時一律帶自己的 owner 篩選。

## 完成通知與例行任務

若宿主提供 `PI_NOTIFY_URL` 與 `PI_NOTIFY_SECRET`，任務結束會 POST：

```json
{"source":"claude-task","id":"...","owner":"YOUR_AGENT_ID","state":"done","exit_code":0}
```

內容不含 prompt 或 result。收到 `source=claude-task` 的通知時，處理流程和
[pi-task-notify 例行任務](../../routines/pi-task-notify.md) 相同，但查詢與 ack
必須改用 `claude-task`，不要用 `pi-task` 查同一個 ID：

```text
~/tools/pi-call/claude-task pending --owner YOUR_AGENT_ID
~/tools/pi-call/claude-task status ID
~/tools/pi-call/claude-task ack ID --owner YOUR_AGENT_ID
```

其他 Bot 的任務用 SendToAgent（priority=true）轉給其 owner；若例行任務不能送訊息，
把 ID、owner、state 回傳給主 Bot 轉送，不要自行檢查或 ack。無 owner 的任務只提醒
使用者。沒有通知時，下次喚醒用 `pending` 找回，不要因此重跑。

## 邊界與排錯

- 節省模型／搜尋配額，避免空白、重複或沒有驗收條件的呼叫。
- `claude` 找不到：確認 `~/.local/bin` 在 PATH，或設定 `CLAUDE_BIN`。
- 認證失敗：請使用者自行重新登入 Claude Code；不要讀 `~/.claude/` 或代替登入。
- Timeout：拆小工作或提高 `--timeout`。失敗後先讀 `status.json`、
  `claude.jsonl`、`events.jsonl` 找原因。
- 任務 interrupted：runner 已消失。先查事件與原因，必要時取得使用者同意再重建；
  不要自動重跑。
- 需要一次或兩次修正時，用 `reply` 給明確回饋；不要無限迴圈。仍然失敗就接手處理，
  向使用者說明限制。
