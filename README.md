# Elizabeth Bot

一個 Discord AI 機械人，支援：
- OpenAI GPT 回答
- Google Custom Search API (自動 fallback / search 指令)
- Moderation filter (安全過濾)

## 使用方法

1. 複製 `.env.example` 改成 `.env`，填好 API Keys
2. 安裝依賴
   ```bash
   npm install
   ```
3. 運行
   ```bash
   node index.js
   ```

## 指令
- 普通文字：GPT 回答
- `search xxx`：直接用 Google 搜尋 + Reference Links
