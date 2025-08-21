import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fetch from "node-fetch";

// ---- ENV ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;       // Railway naming
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID;          // Railway naming
const OPTIONAL_PREFIX = process.env.PREFIX || "";               // optional; mention trigger works without it

// ---- Clients ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Simple per-user cooldown (ms) ----
const cooldownMs = 5000;
const lastCall = new Map();

// Utility: chunk long replies to respect Discord's 2000-char limit
function chunk(text, size = 1900) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const content = message.content.trim();

    // Mentions can be <@id> or <@!id>
    const mentionA = `<@${client.user.id}>`;
    const mentionB = `<@!${client.user.id}>`;
    const byMention = content.startsWith(mentionA) || content.startsWith(mentionB);
    const byPrefix = OPTIONAL_PREFIX && content.startsWith(OPTIONAL_PREFIX);

    if (!byMention && !byPrefix) return; // only respond to mention or optional prefix

    let prompt = content;
    if (byMention) {
      prompt = prompt.replace(mentionA, "").replace(mentionB, "").trim();
    } else if (byPrefix) {
      prompt = prompt.slice(OPTIONAL_PREFIX.length).trim();
    }
    if (!prompt) return;

    // Cooldown per user
    const now = Date.now();
    const prev = lastCall.get(message.author.id) || 0;
    if (now - prev < cooldownMs) {
      return void message.reply("⚠️ 慢慢嚟啦，畀我抖一抖先（幾秒後再試）。");
    }
    lastCall.set(message.author.id, now);

    // ---- STEP 1: Ask GPT whether to search (YES/NO) ----
    let decision = "NO";
    try {
      const judge = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 3,
        messages: [
          {
            role: "system",
            content:
              "你係一個判斷器。只可以回覆 YES 或 NO。當用戶問題屬於新聞/最新變動/價格/即時數據/比較購買/版本更新/錯誤碼/下載連結/官方教學/地點時間等需要上網查資料先答得準的情況，就回覆 YES；否則回覆 NO。",
          },
          { role: "user", content: prompt },
        ],
      });
      decision = (judge.choices?.[0]?.message?.content || "NO").trim().toUpperCase();
    } catch (e) {
      console.warn("judge step failed:", e?.message || e);
      decision = "NO"; // fallback
    }
    console.log(`🔎 Search decision: ${decision}`);

    // ---- STEP 2: If YES, fetch Google Custom Search top results ----
    let searchDigest = "";
    let linksForFooter = [];
    if (decision === "YES" && GOOGLE_API_KEY && GOOGLE_CX) {
      try {
        const q = encodeURIComponent(prompt);
        const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&num=5&hl=zh-HK&q=${q}`;
        const res = await fetch(url, { timeout: 15000 });
        const data = await res.json();
        if (data?.items?.length) {
          const top = data.items.slice(0, 3);
          searchDigest = top
            .map((it, idx) => `(${idx + 1}) ${it.title}\n${it.snippet || ""}\n${it.link}`)
            .join("\n\n");
          linksForFooter = top.map((it, idx) => `[${idx + 1}] ${it.link}`);
        }
        console.log(`🌐 Search results found: ${data?.items?.length || 0}`);
      } catch (e) {
        console.warn("google search failed:", e?.message || e);
      }
    }

    // ---- STEP 3: Compose persona + final answer ----
    const systemPersona =
      "你叫「伊莉莎白」。你係一個超毒蛇但有趣嘅 Discord 幫手，人設係銀魂入面嘅角色，用香港廣東話（繁體）講嘢。準則：1) 保持寸嘴，但要有內涵；2) 先講重點、精簡直接；3) 有需要可以少量顏文字表情符號加強語氣；4) 如果我提供咗搜尋摘要，你要自己消化後用你嘅語氣答，唔好逐字抄；5) 只係喺有用過搜尋先可以喺文末『可選擇性』列 1-3 條來源連結。";

    const userMsg = searchDigest
      ? `用戶問題：${prompt}\n\n以下係搜尋摘要（作參考）：\n${searchDigest}`
      : prompt;

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPersona },
        { role: "user", content: userMsg },
      ],
    });

    let reply = ai.choices?.[0]?.message?.content?.trim() || "……我暫時講唔到，你可唔可以講清楚啲？";

    // Optionally append sources only if we actually searched & we have links
    if (searchDigest && linksForFooter.length) {
      reply += `\n\n— 參考（揀幾條睇）：\n${linksForFooter.join("\n")}`;
    }

    // Send in chunks if too long
    for (const part of chunk(reply)) {
      // eslint-disable-next-line no-await-in-loop
      await message.reply(part);
    }
  } catch (err) {
    console.error("❌ Handler error:", err);
    const msg =
      err?.status === 429
        ? "⏳ API 用得太密，等陣先再試啦。"
        : "❌ 出事咗，我轉個身再返嚟。";
    try {
      await message.reply(msg);
    } catch {}
  }
});

client.login(DISCORD_TOKEN);
