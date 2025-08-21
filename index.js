import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

client.on("ready", () => {
  console.log(`✅ Bot 已上線：${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!chat")) {
    const userMessage = message.content.replace("!chat", "").trim();

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userMessage }],
      });

      message.reply(response.choices[0].message.content);
    } catch (err) {
      console.error(err);
      message.reply("⚠️ 出錯咗，檢查下 API key 同 Token。");
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
