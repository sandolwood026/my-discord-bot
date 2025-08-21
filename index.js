import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID;

// 🛡️ Moderation filter
async function moderateInput(input) {
  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const data = await res.json();
  return data.results[0].flagged;
}

// 🌐 Google Search
async function searchGoogle(query) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.items) return "❌ 無搜尋結果";
  return data.items.slice(0, 3).map(item => {
    return `🔗 [${item.title}](${item.link})\n${item.snippet}`;
  }).join("\n\n");
}

// 🤖 GPT 回答
async function askGPT(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userInput = message.content;

  // 🔍 如果用家問 "search xxx" 就強制用 Google
  if (userInput.startsWith("search ")) {
    const query = userInput.replace("search ", "");
    const results = await searchGoogle(query);
    message.reply(`📰 Google Search 結果：\n\n${results}`);
    return;
  }

  // 🛡️ Check moderation
  const flagged = await moderateInput(userInput);
  if (flagged) {
    message.reply("⚠️ 抱歉，呢個問題可能包含敏感內容。");
    return;
  }

  // 🧠 先問 GPT
  let gptAnswer = await askGPT(userInput);

  // 如果 GPT 答得好模糊，就 call Google
  if (!gptAnswer || gptAnswer.includes("我唔確定") || gptAnswer.length < 20) {
    const searchResults = await searchGoogle(userInput);
    gptAnswer += `\n\n📚 參考資料：\n${searchResults}`;
  }

  message.reply(gptAnswer);
});

client.login(DISCORD_TOKEN);
