import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// moderation
async function moderateInput(text) {
  const response = await openai.moderations.create({ model: "omni-moderation-latest", input: text });
  return response.results[0].flagged;
}

// Google Search
async function googleSearch(query) {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.items) return "（找不到相關搜尋結果）";
  return data.items.slice(0, 3).map((item, i) => `${i+1}. [${item.title}](${item.link})`).join("\n");
}

// GPT 回答
async function askGPT(prompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });
  return response.choices[0].message.content;
}

// Discord handler
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const query = message.content.replace(/<@!?\d+>/, "").trim();
  if (!query) return;

  try {
    if (await moderateInput(query)) {
      await message.reply("⚠️ 呢個問題有違規成份，我唔方便回答。");
      return;
    }

    let reply = await askGPT(query);

    // 如果 GPT 答得好普通，試下 Google
    if (reply.length < 20 || reply.includes("我唔清楚")) {
      const googleResults = await googleSearch(query);
      reply += `\n\n🔎 相關搜尋:\n${googleResults}`;
    }

    await message.reply(reply);
  } catch (err) {
    console.error(err);
    await message.reply("❌ 發生咗錯誤，請稍後再試！");
  }
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
