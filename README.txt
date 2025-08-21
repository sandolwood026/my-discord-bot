# ChatGPT Discord Bot (Railway 版本)

## 🚀 部署步驟

1. Fork/上傳呢個 repo 去 GitHub

2. 去 Railway (https://railway.app/) 建立新 Project
   - 選擇 Deploy from GitHub
   - 連接你嘅 repo

3. 喺 Railway 專案 -> Variables 新增：
   - DISCORD_BOT_TOKEN=你嘅 Discord Bot Token
   - OPENAI_API_KEY=你嘅 OpenAI API Key

4. Railway 會自動偵測 Node.js
   - 用 package.json 嘅 start script ("npm start")

5. Deploy 完成後，你嘅 Bot 就會 24/7 運行 🎉

## ⚠️ 注意
- API Key & Token 一定要保密
- 如果 Bot 冇回應，去 Railway 日誌 Logs 睇錯誤
