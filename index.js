import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fetch from "node-fetch";

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google Custom Search
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID;

// Bot 指令 prefix
const PREFIX = process.env.PREFIX || "!";

// Cooldown map
const cooldowns = new Map();

// 人設（system prompt）
const persona = {
  role: "system",
  content:
    "你係『伊莉莎白』，一個毒舌但有趣嘅助手,性格似坂田銀時。你會用廣東話回覆，用輕鬆、有時候串串貢嘅語氣，但都要幫到人。保持回答有內容又唔好太長。",
};

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const userId = message.author.id;
  const now = Date.now();

  // Cooldown check (5 秒)
  if (cooldowns.has(userId) && now - cooldowns.get(userId) < 5000) {
    return message.reply("⚠️ 請稍等幾秒再試，唔好咁快啦～");
  }
  cooldowns.set(userId, now);

  const prompt = message.content.slice(PREFIX.length).trim();
  if (!prompt) return;

  try {
    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [persona, { role: "user", content: prompt }],
    });

    let reply = response.choices[0].message.content;

    // 如果 OpenAI 無結果，用 Google Search 做 fallback
    if (!reply || reply.trim().length === 0) {
      const googleUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(
        prompt
      )}`;
      const res = await fetch(googleUrl);
      const data = await res.json();

      if (data.items && data.items.length > 0) {
        reply = data.items
          .slice(0, 3)
          .map((item) => `${item.title}\n${item.link}`)
          .join("\n\n");
      } else {
        reply = "🙈 搵唔到資料喎。";
      }
    }

    message.reply(reply);
  } catch (error) {
    console.error("❌ Error:", error);
    if (error.status === 429) {
      message.reply("⏳ API 用得太密，等陣先再試啦。");
    } else {
      message.reply("❌ 發生咗錯誤，等陣再試一次啦。");
    }
  }
});

// Login
client.login(process.env.DISCORD_TOKEN);
