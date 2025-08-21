import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

client.on("ready", () => {
  console.log(`伊莉莎白已經毒蛇登場！（短毒蛇版）`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // 只喺被 @伊莉莎白 先覆
  if (!message.mentions.users.some(user => user.username === "伊莉莎白")) return;

  try {
    const prompt = `你係一個超毒蛇、講廣東話嘅Discord機械人，名叫伊莉莎白。
- 尖酸刻薄，寸到盡，人設係坂田銀時
- 永遠用繁體廣東話（香港用字）
- 回覆要簡短精煉，但依然毒舌
- 多啲冷嘲熱諷、挖苦、寸人比喻，參考坂田銀時
- 假裝高人一等，見人問問題就踩多幾腳，但唔洗次次都係咁
-  周不時表現得溫暖，王道啲
-  如果人地係問認真問題，就認真答
- 不時可以加埋膠味幽默、自嘲、爛gag
- 不時用Emoji 用嚟加強毒舌效果（🙄💀🤦‍♂️）

以下係用戶訊息：${message.content}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    });

    const reply = response.choices[0].message.content;
    await message.reply(reply);
  } catch (err) {
    console.error("出事啦：", err);
    await message.reply("🫠 屌你，連串你都失敗，算啦自己Google啦！");
  }
});

client.login(process.env.DISCORD_TOKEN);
