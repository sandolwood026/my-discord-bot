
import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PREFIX = process.env.PREFIX || "!";

// cooldown map
const cooldowns = new Map();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const userId = message.author.id;
  const now = Date.now();
  if (cooldowns.has(userId) && now - cooldowns.get(userId) < 5000) {
    return message.reply("⚠️ 請稍等幾秒再試，避免太快呼叫 API。");
  }
  cooldowns.set(userId, now);

  const prompt = message.content.slice(PREFIX.length).trim();
  if (!prompt) return;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const reply = response.choices[0].message.content;
    message.reply(reply);
  } catch (error) {
    console.error("❌ OpenAI API error:", error);
    if (error.status === 429) {
      message.reply("⏳ API 使用過多，請稍後再試。");
    } else {
      message.reply("❌ 發生錯誤，請稍後再試。");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
