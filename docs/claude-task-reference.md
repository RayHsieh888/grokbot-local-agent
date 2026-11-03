# claude-task reference（Claude Code 派工）

`claude-task` 是本 fork 新增的 Claude Code 派工入口。它把 Claude Code CLI 的
一次性 `-p` 呼叫包裝成可追蹤、可續接、可取消的任務，並沿用 `pi-task` 的
owner 路由、`pending`／`ack`、完成 webhook 與 orphan 偵測設計。

- Node 22+，無第三方依賴。
- 任務紀錄目錄：`$CLAUDE_TASK_DIR`，預設 `~/.claude-tasks/<ID>/`；Claude 實際工作目錄由 `run <cwd>` 指定。
- 任務 ID 格式：`<session>-<YYYYMMDD-HHMMSS>`，同一 session 只允許一個執行中的任務。
- **`--model` 必填**，只能使用 `opus`、`sonnet`、`haiku`，或以 `claude-` 開頭的完整模型名。
- 派工入口本身不讀取 `~/.claude/` 下的任何檔案、session 或 token；Claude Code 自行處理登入。
- 完成通知的 `source` 是 `claude-task`，與 `pi-task` 的 `source=pi-task` 區分。

> `run <cwd> "<prompt>"` 必須指定一個已存在的專案資料夾；Claude Code 的子程序
> 就以該 cwd 執行，和 `pi-task run <cwd>` 一致。任務紀錄（`status.json`、
> `events.jsonl`、`claude.jsonl`、`result.md`）仍放在 `~/.claude-tasks/<ID>/`，
> 不會寫進專案資料夾。

## 安裝

```bash
mkdir -p ~/tools/pi-call && cp -a bin/. ~/tools/pi-call/
chmod +x ~/tools/pi-call/claude-task ~/tools/pi-call/claude-task.mjs
```

`bin/claude-task` 是可執行 wrapper，會找到同目錄的 `claude-task.mjs`，並把
`~/.local/bin` 加到 PATH。Claude Code 的安裝與使用者登入見
[setup-guide.md](setup-guide.md)。`CLAUDE_BIN` 可指定其他可執行檔，預設 `claude`。

## 用法

以下指令假設 `claude-task` 已在 PATH；否則使用 `~/tools/pi-call/claude-task`。
角括號是占位符，請換成實際值。

```text
claude-task run <cwd> "<prompt>" --session <name> --model <opus|sonnet|haiku|claude-*>
             [--owner <agent id>] [--timeout sec] [--no-write] [--no-web]
claude-task reply <ID> "<prompt>" [--model <model>] [--timeout sec]
claude-task status <ID>
claude-task list [--all] [--owner <id>|none]
claude-task cancel <ID>
claude-task pending [--owner <id>|none]
claude-task ack <ID> [<ID>...] [--owner <id>|none]
```

`run` 的第一個位置參數是 cwd（必須存在且是資料夾，否則以 usage error 拒絕），
第二個是 prompt。cwd 會解析成絕對路徑並存入 `status.cwd`。Timeout 預設 300 秒；
`0` 表示停用。Session 名稱中的空白與路徑分隔符會正規化成連字號。

```bash
mkdir -p /tmp/claude-project
CLAUDE_TASK_DIR=/tmp/claude-tasks ~/tools/pi-call/claude-task run \
  /tmp/claude-project "建立 hello.txt，內容為 hello，完成後回報檔名與內容。" \
  --session hello --model sonnet --owner YOUR_AGENT_ID
# TASK hello-20261018-151601
# STATE done
# RESULT /tmp/claude-tasks/hello-20261018-151601/result.md

CLAUDE_TASK_DIR=/tmp/claude-tasks ~/tools/pi-call/claude-task reply \
  hello-20261018-151601 "把 hello.txt 改成 hello world"
# reply 沿用 status.cwd（/tmp/claude-project）
```

長任務請用 Bot Shell 工具自帶的背景模式啟動 `run`，記下 stdout 第一行
`TASK <ID>`，之後用 `pending`／`status` 取回結果：

```bash
~/tools/pi-call/claude-task pending --owner YOUR_AGENT_ID
~/tools/pi-call/claude-task status TASK_ID
# 讀 result.md，必要時檢查 claude.jsonl／events.jsonl、diff 或測試
~/tools/pi-call/claude-task ack TASK_ID --owner YOUR_AGENT_ID
```

## 模型選擇

`--model` 一律明確指定，不要省略，也不要依賴 Claude Code 的互動式預設值：

| 模型 | 適用工作 |
| --- | --- |
| `opus` | 複雜重構、跨檔案推理、難度高的除錯、需要較強判斷的長任務 |
| `sonnet` | 一般實作、文件撰寫、中等規模修改、日常主力 |
| `haiku` | 小改動、格式整理、簡單問答、低風險的批次處理 |

也可以傳完整名稱，例如 `claude-sonnet-4-5`；只要是 `claude-` 開頭即可。
`reply` 預設沿用任務原本的 model，可用 `reply --model` 覆寫。其他字串
（例如 `gpt`）或缺少 `--model` 會以 usage error（exit 2）拒絕，不會建立任務。

## 權限與工具

| 參數 | Claude Code 參數 | 效果 |
| --- | --- | --- |
| 預設 | `--permission-mode acceptEdits` | 可讀取並接受檔案編輯 |
| `--no-write` | `--permission-mode plan` | 唯讀／規劃模式，不進行編輯 |
| `--no-web` | `--disallowedTools WebFetch WebSearch` | 停用網路抓取與搜尋工具 |

實際命令為：

```text
claude -p "<prompt>" --model <model> --output-format stream-json --verbose \
  --permission-mode acceptEdits|plan [--disallowedTools WebFetch WebSearch] \
  [--resume <claude_session_id>]
```

`--no-write` 與 `--no-web` 會記錄在任務的 `options`，`reply` 沿用原設定。
這些是工具／權限設定，不是作業系統層級的沙箱。仍應給 Claude 明確、狹窄的
工作範圍，不要讓它處理部署、對外發送訊息或刪除重要檔案。

## 執行與續接

1. `run` 檢查 cwd 存在且是資料夾，解析成絕對路徑寫入 `status.cwd`；任務紀錄
   資料夾建立在任務 store 下，寫入 `status.json`，狀態先為 `queued`，隨即在
   `execute` 中改為 `running`。
2. 以 `status.cwd` 為 cwd 啟動 `CLAUDE_BIN`；Claude 的 stdout 每一行 stream-json
   會原樣追加到任務紀錄資料夾的 `claude.jsonl`。
3. 從 stream-json 解析：
   - `type=system`, `subtype=init`：把 `session_id` 存進
     `status.claude_session_id`，並記 `session_init` 事件。
   - `type=assistant`：把文字內容記成 `message_end` 事件（摘要，單行、最多 500 字）。
   - `type=result`：把 `result` 文字寫成 `result.md`；`is_error` 決定成功或失敗，
     並記 `result` 事件（含狀態、耗時、費用，若有）。
4. 子程序結束後寫 `task_end`、更新 `status.json`，必要時送出 webhook。
5. `reply` 會檢查任務已結束、`status.cwd` 仍存在、session 未被其他任務佔用，先將
   `reported` 設回 `false` 並寫入 status，再以
   `--resume <claude_session_id>` 接續同一個 Claude session。

`reply` 不改變 owner；`--owner` 在 `reply` 會被拒絕。它沿用第一次 run 的
`options`（write／web）與 `status.cwd`，model 則沿用目前 status 的 model，可由
`--model` 覆寫。

## 任務儲存

根目錄：`$CLAUDE_TASK_DIR`，預設 `~/.claude-tasks`。每個任務一個 `<ID>/`：

| 檔案 | 內容 |
| --- | --- |
| `status.json` | 狀態、owner、model、session、pid、claude session、runs、options；以暫存檔＋rename 原子寫入 |
| `events.jsonl` | `task_start`、`session_init`、`message_end`、`result`、`task_end`、`notify`、`orphan_detected`、`cancel_signal` 等事件；文字正規化為單行並截斷至 500 字 |
| `claude.jsonl` | Claude Code stdout 的原始 stream-json，逐行追加（多次 reply 會累積） |
| `result.md` | `type=result` 的 `result` 文字；若沒有 result 但有 assistant 文字，結束時以最後 assistant 文字作後備 |
| `prompt-N.txt` | 第 N 次執行的 prompt |

`status.json` 範例：

```json
{
  "id": "docs-20261018-151601",
  "session": "docs",
  "owner": "YOUR_AGENT_ID",
  "cwd": "/home/me/repo",
  "model": "sonnet",
  "state": "done",
  "pid": null,
  "claude_pid": null,
  "claude_session_id": "a1b2c3d4-...",
  "created_at": "2026-10-18T07:16:01.650Z",
  "started_at": "2026-10-18T07:16:01.652Z",
  "ended_at": "2026-10-18T07:16:03.541Z",
  "exit_code": 0,
  "error": null,
  "reported": false,
  "runs": [
    {
      "n": 1,
      "prompt": "建立 hello.txt",
      "model": "sonnet",
      "claude_session_id": "a1b2c3d4-...",
      "started_at": "2026-10-18T07:16:01.652Z",
      "ended_at": "2026-10-18T07:16:03.541Z",
      "exit_code": 0
    }
  ],
  "options": { "write": true, "web": true }
}
```

儲存時間戳為 ISO UTC；顯示時間與 ID 使用主機本地時區。`status` 輸出人類可讀
摘要，若要 exit_code 等完整欄位可直接檢視 `status.json`，但不要手動修改。

## 狀態與退出碼

狀態：`queued`、`running`、`done`、`failed`、`cancelled`、`interrupted`。

| 退出碼 | 意義 |
| --- | --- |
| 0 | done |
| 1 | failed、拒絕操作或命令錯誤 |
| 2 | usage error（缺少參數、非法 timeout／model 等） |
| 124 | timeout：state=failed，error="timeout" |
| 130 | cancelled |

- **Timeout**：到時後先對整個 Claude process group 送 SIGTERM，最多等 5 秒，
  再 SIGKILL 並記錄 timeout。
- **Cancel**：`cancel <ID>` 對 runner 送 SIGTERM；runner 會殺掉 Claude process
  group 並記錄 cancelled。若 runner 12 秒內沒有結束，`cancel` 會 SIGKILL runner
  與已知的 Claude process group，並記錄強制取消。
- **Orphan 偵測**：任何子命令開始時，若某任務標記為 `running` 但記錄的 runner
  PID 已不存在，會改為 `interrupted`、寫 `orphan_detected` 事件。這可處理 runner
  被 SIGKILL、主機重啟等情況。發現 interrupted 後，先查原因，不要自動重跑。

同一個 session 同時只允許一個 running 任務；`run` 遇到已佔用的 session 會拒絕，
`reply` 遇到仍在執行的任務也會拒絕。

## Owner 與 pending／ack

Owner 是派工 Bot 的 agent ID，例如
`/home/box/agent-data/agents/YOUR_AGENT_ID/profile.json`。

- `run --owner <id>` 將 owner 寫入 status。
- 沒有 `--owner` 時讀 `CLAUDE_TASK_OWNER`；兩者都沒有則 owner=null，並在 stderr 警告。
- 空值或含空白的 owner 會被拒絕；`reply` 不能改 owner。
- `--owner none` 只匹配 owner=null；不要把字串 `none` 當成 Bot ID。

| 指令 | 無 owner 篩選 | `--owner ID` | `--owner none` |
| --- | --- | --- | --- |
| pending | 所有已結束且未回報 | 只列該 owner | 只列無 owner |
| list | 所有 running／近期任務 | 只列該 owner | 只列無 owner |
| ack | 不檢查 owner | 拒絕不符者 | 拒絕非 null owner |

多個 ID 的 `ack` 即使部分被拒絕，符合的仍會標記；只要有拒絕，退出碼為 1。
Owner 是路由紀律，不是作業系統安全邊界。Bot 使用時務必帶自己的 owner 篩選。

輸出中的 `owner=<id|->`，`-` 表示無 owner：

```text
hello-20261018-151601  owner=YOUR_AGENT_ID  done  runs=1  created=21m ago
```

## 完成 webhook

沿用 `pi-task` 的環境變數：`PI_NOTIFY_URL`、`PI_NOTIFY_SECRET`（原始 Bearer
token，不含 `Bearer` 前綴）。兩者都存在且 `PI_NOTIFY_OFF` 未設定時，任務結束會
以背景 notifier POST：

```json
{"source":"claude-task","id":"hello-20261018-151601","owner":"YOUR_AGENT_ID","state":"done","exit_code":0}
```

不包含 prompt 或 result 內容。成功或失敗的 HTTP 結果會寫成 `notify` 事件。
通知失敗不影響任務結果；下次喚醒時用 `pending` 補回報，不要因此重跑。
接收端的例行任務應以 `source=claude-task` 判斷，改用
`claude-task status`／`claude-task ack`，不要拿 `pi-task` 去查 Claude 任務。

## 環境變數

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `CLAUDE_TASK_DIR` | `~/.claude-tasks` | 任務儲存根目錄 |
| `CLAUDE_TASK_OWNER` | 空 | `run` 的預設 owner（沒有 `--owner` 時的 fallback） |
| `CLAUDE_BIN` | `claude` | Claude Code 可執行檔 |
| `PI_NOTIFY_URL` | 空 | 完成 webhook 端點 |
| `PI_NOTIFY_SECRET` | 空 | 通知 Bearer token，只從環境提供 |
| `PI_NOTIFY_OFF` | 空 | 設為 1 可暫時停用通知 |
| `ANTHROPIC_API_KEY` | 空 | Claude Code 自身認證用；若使用登入流程則不一定要設 |

通知相關變數與 `CLOUDFLARE_API_TOKEN`、`TELEGRAM_BOT_TOKEN` 會從 Claude 子程序
環境中刪除；`ANTHROPIC_API_KEY` 等 Claude 自身需要的變數會保留。notifier 是另一個
背景程序，從環境取得 secret，不把 secret 放進 argv。

## 安全邊界

- `claude-task` **不讀取也不輸出** `~/.claude/` 下的任何檔案、session、token 或
  認證資料。Claude Code 的登入、token 與憑證由 Claude Code 自己管理。
- 金鑰（例如 `ANTHROPIC_API_KEY`）只透過宿主的安全輸入／環境變數提供，不寫入
  任務檔案、prompt、repo 或命令列參數。不要把金鑰貼進對話或 prompt。
- 使用者必須自行完成 Claude Code 登入；Bot 不代替使用者登入，也不檢查 `~/.claude/`。
- 任務的 `claude.jsonl`／`events.jsonl` 可能包含 Claude 的輸出與工具參數摘要；
  不要把它們當作憑證來源，也不要把敏感檔案內容交給 Claude。
- 派工前確認工作範圍；`acceptEdits` 不是沙箱。部署、push、對外發送訊息、刪除重要
  檔案仍需使用者明確授權。

## 與 pi-task 的差異

| 項目 | pi-task | claude-task |
| --- | --- | --- |
| 後端 | `pi --mode rpc` | `claude -p ... --output-format stream-json --verbose` |
| 工作目錄 | `run <cwd>` 指定 | `run <cwd>` 指定；`reply` 沿用 `status.cwd` |
| 模型 | 有預設，可 `--model provider/model` | `--model` 必填，只接受 opus/sonnet/haiku/claude-* |
| 續接 | Pi session ID（`--session-id`） | Claude `--resume <claude_session_id>` |
| 原始輸出 | RPC JSON 事件 | `claude.jsonl`（逐行原始 stream-json） |
| 任務根目錄 | `~/.pi/tasks` | `~/.claude-tasks` |
| 通知 source | `pi-task` | `claude-task` |

## 排錯

- `claude: command not found`：確認 `~/.local/bin` 在 PATH，或設定 `CLAUDE_BIN`。
- 認證失敗：由使用者重新執行 Claude Code 登入流程；不要讀取或複製 `~/.claude/`。
- Timeout：把工作切小或提高 `--timeout`。失敗後先看 `status.json`、`claude.jsonl`、
  `events.jsonl` 的錯誤，不要自動重跑。
- 任務顯示 interrupted：runner 已消失。查看最後事件與 `claude.jsonl`，必要時才由
  使用者授權後重新建立任務。
- 通知沒到：檢查 `notify` 事件、`PI_NOTIFY_URL`／`PI_NOTIFY_SECRET` 是否在 Bot
  shell 環境中；用 `pending` 補回報。
- 想看即時進度：使用
  [`tools/pi-telegram-monitor`](../tools/pi-telegram-monitor/README.md)，它會監看
  `$CLAUDE_TASK_DIR/<ID>/claude.jsonl` 與 `events.jsonl`。
