import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from "discord.js";
import OpenAI from "openai";
import fetch from "node-fetch";
import pkg from "pg";
const { Pool } = pkg;

// ===== 固定預設（可被環境變數覆蓋）=====
const PRESET_ADMIN_ID = "346554100370112512";      // 你嘅 UID
const PRESET_LOG_CHANNEL_ID = "1408131811837739180"; // 你嘅 log channel
const PRESET_DEFAULT_MODE = "smart";                 // passive | smart | always

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ENV_MODEL = process.env.MODEL || "gpt-4o-mini";
const OPTIONAL_PREFIX = process.env.PREFIX || "";
const DEFAULT_MODE = (process.env.DEFAULT_MODE || PRESET_DEFAULT_MODE).toLowerCase();
const DEFAULT_LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || PRESET_LOG_CHANNEL_ID;
const ADMIN_IDS_ENV = (process.env.ADMIN_IDS || PRESET_ADMIN_ID)
  .split(",").map(s => s.trim()).filter(Boolean);
const VERBOSE_LOGS = process.env.VERBOSE_LOGS === "1";

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== OpenAI Client =====
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== Postgres =====
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } }) : null;

async function ensureTables() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'passive',    -- passive|smart|always
      prefix TEXT DEFAULT '',
      persona TEXT,
      include_sources BOOLEAN DEFAULT false,
      model TEXT DEFAULT 'gpt-4o-mini',
      log_channel_id TEXT,
      log_all BOOLEAN DEFAULT false
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS convo_logs (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT, channel_id TEXT, message_id TEXT, user_id TEXT,
      content TEXT, reply TEXT, used_search BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ===== In-memory =====
const cooldownMs = 5000;
const lastCall = new Map();

// ===== Persona（GPT 風格，精簡、有用）=====
const DEFAULT_PERSONA =
  "你叫「伊莉莎白」。你係一個語氣聰明、寸得嚟有禮、但以『有用為先、精簡直接』為原則嘅助手。用香港廣東話（繁體）回覆。回應準則：1) 先講重點，再補充；2) 可以輕微毒舌，但避免人身攻擊；3) 必要時用 1-3 點列出；4) 如我提供咗搜尋摘要，請自行整合，用你嘅語氣重寫；5) 只係當我真係做過搜尋，先『可選擇性』在文末列來源連結。";

// ===== Helpers =====
function chunk(text, size = 1900) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
const truncate = (s, n = 400) => (s?.length > n ? s.slice(0, n) + " …" : s || "");

async function getSettings(guild) {
  if (!pool || !guild) {
    return {
      mode: DEFAULT_MODE, prefix: OPTIONAL_PREFIX, persona: DEFAULT_PERSONA,
      include_sources: false, model: ENV_MODEL, log_channel_id: DEFAULT_LOG_CHANNEL_ID, log_all: false
    };
  }
  const { rows } = await pool.query("SELECT * FROM guild_settings WHERE guild_id = $1", [guild.id]);
  if (rows.length) {
    const r = rows[0];
    return {
      mode: r.mode || DEFAULT_MODE,
      prefix: (r.prefix ?? OPTIONAL_PREFIX) || "",
      persona: r.persona || DEFAULT_PERSONA,
      include_sources: !!r.include_sources,
      model: r.model || ENV_MODEL,
      log_channel_id: r.log_channel_id || DEFAULT_LOG_CHANNEL_ID,
      log_all: !!r.log_all,
    };
  }
  await pool.query(
    "INSERT INTO guild_settings (guild_id, mode, prefix, persona, include_sources, model, log_channel_id, log_all) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (guild_id) DO NOTHING",
    [guild.id, DEFAULT_MODE, OPTIONAL_PREFIX, DEFAULT_PERSONA, false, ENV_MODEL, DEFAULT_LOG_CHANNEL_ID, false]
  );
  return {
    mode: DEFAULT_MODE, prefix: OPTIONAL_PREFIX, persona: DEFAULT_PERSONA,
    include_sources: false, model: ENV_MODEL, log_channel_id: DEFAULT_LOG_CHANNEL_ID, log_all: false
  };
}

async function setSettings(guildId, patch) {
  if (!pool) return;
  const keys = Object.keys(patch);
  if (!keys.length) return;
  // UPSERT：INSERT + ON CONFLICT UPDATE
  const insertCols = ["guild_id", ...keys];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(", ");
  const updateCols = keys.map(k => `${k} = EXCLUDED.${k}`).join(", ");
  const values = [guildId, ...keys.map(k => patch[k])];
  const sql = `INSERT INTO guild_settings (${insertCols.join(",")}) VALUES (${placeholders})
               ON CONFLICT (guild_id) DO UPDATE SET ${updateCols}`;
  await pool.query(sql, values);
}

async function isAdmin(guildId, userId) {
  if (ADMIN_IDS_ENV.includes(userId)) return true;
  if (!pool) return false;
  const { rows } = await pool.query("SELECT 1 FROM admins WHERE guild_id=$1 AND user_id=$2", [guildId, userId]);
  return rows.length > 0;
}

async function addAdmin(guildId, userId) {
  if (!pool) return;
  await pool.query("INSERT INTO admins (guild_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [guildId, userId]);
}

async function ensureLogChannel(guild) {
  try {
    if (!guild) return null;
    const settings = await getSettings(guild);
    if (settings.log_channel_id) {
      const ch = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
      if (ch && ch.type === ChannelType.GuildText) return ch;
    }
    if (DEFAULT_LOG_CHANNEL_ID) {
      const ch = await guild.channels.fetch(DEFAULT_LOG_CHANNEL_ID).catch(() => null);
      if (ch && ch.type === ChannelType.GuildText) return ch;
    }
    const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === "elizabeth-log");
    if (existing) {
      await setSettings(guild.id, { log_channel_id: existing.id });
      return existing;
    }
    if (guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      const created = await guild.channels.create({ name: "elizabeth-log", type: ChannelType.GuildText, reason: "Auto-created for Elizabeth logs" });
      await setSettings(guild.id, { log_channel_id: created.id });
      return created;
    }
  } catch (e) {
    console.warn("ensureLogChannel:", e?.message || e);
  }
  return null;
}

async function logToChannel(message, replyText, usedSearch, links) {
  try {
    const settings = await getSettings(message.guild);
    if (!settings.log_channel_id) return;
    const ch = await message.guild.channels.fetch(settings.log_channel_id).catch(() => null);
    if (!ch) return;
    await ch.send({
      embeds: [{
        title: "伊莉莎白 對話記錄",
        color: usedSearch ? 0x22cc88 : 0x8b5cf6,
        timestamp: new Date().toISOString(),
        fields: [
          { name: "用戶", value: `${message.author.tag} (${message.author.id})`, inline: false },
          { name: "內容", value: "```\n" + truncate(message.content, 900) + "\n```", inline: false },
          { name: "回覆", value: "```\n" + truncate(replyText, 900) + "\n```", inline: false },
          { name: "是否用了搜尋", value: usedSearch ? "YES" : "NO", inline: true },
          { name: "頻道", value: `${message.channel?.name || "DM"} (${message.channelId})`, inline: true },
          ...(links?.length ? [{ name: "來源", value: links.join("\n").slice(0, 1000), inline: false }] : [])
        ]
      }]
    });
  } catch (e) {
    console.warn("logToChannel failed:", e?.message || e);
  }
}

async function logToDB(message, replyText, usedSearch) {
  try {
    if (!pool) return;
    await pool.query(
      "INSERT INTO convo_logs (guild_id, channel_id, message_id, user_id, content, reply, used_search) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [message.guild?.id || null, message.channelId, message.id, message.author.id, message.content, replyText, !!usedSearch]
    );
  } catch (e) {
    console.warn("logToDB failed:", e?.message || e);
  }
}

function looksLikeAQuestion(text) {
  return /[?？]|(點樣|點做|幾時|邊度|點解|點先|如何|係咪)/i.test(text);
}

// ===== Startup =====
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  if (pool) await ensureTables();

  // 預先把你加入各伺服器 admin
  if (pool && ADMIN_IDS_ENV.length) {
    for (const [, guild] of client.guilds.cache) {
      for (const uid of ADMIN_IDS_ENV) await addAdmin(guild.id, uid);
    }
  }

  // 建立 / 套用 log channel；建立設定行
  for (const [, guild] of client.guilds.cache) {
    await ensureLogChannel(guild);
    await getSettings(guild);
  }
});

// ===== Main handler =====
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    const guild = message.guild;
    const settings = await getSettings(guild);

    const content = message.content.trim();
    const mentionA = `<@${client.user.id}>`;
    const mentionB = `<@!${client.user.id}>`;
    const byMention = content.startsWith(mentionA) || content.startsWith(mentionB);
    const byPrefix = settings.prefix && content.startsWith(settings.prefix);

    // 決定要唔要回覆
    let shouldRespond = false;
    if (settings.mode === "always") {
      shouldRespond = true;
    } else if (settings.mode === "smart") {
      shouldRespond = byMention || byPrefix || looksLikeAQuestion(content) || /\b(伊莉莎白|Elizabeth)\b/i.test(content);
    } else {
      shouldRespond = byMention || byPrefix; // passive
    }

    // ---- Admin 指令（要有 mention 或 prefix）----
    const isPotentialCommand = byMention || byPrefix;
    if (isPotentialCommand) {
      let cmdText = content;
      if (byMention) cmdText = cmdText.replace(mentionA, "").replace(mentionB, "").trim();
      else if (byPrefix) cmdText = cmdText.slice(settings.prefix.length).trim();

      // 人設
      if (/^(設定人設|set\s*persona)\s*[:：]/i.test(cmdText)) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改人設。");
        const newPersona = cmdText.replace(/^(設定人設|set\s*persona)\s*[:：]\s*/i, "").trim();
        if (!newPersona) return void message.reply("⚠️ 用法：設定人設：<內容>");
        await setSettings(guild.id, { persona: newPersona });
        return void message.reply("✅ 人設已更新（只會影響之後的回覆）。");
      }
      if (/^(查看人設|show\s*persona)$/i.test(cmdText))
        return void message.reply("目前人設：\n```\n" + (settings.persona || DEFAULT_PERSONA).slice(0, 1800) + "\n```");
      if (/^(重置人設|reset\s*persona)$/i.test(cmdText)) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權重置人設。");
        await setSettings(guild.id, { persona: DEFAULT_PERSONA });
        return void message.reply("🔄 人設已重置。");
      }

      // 模式
      const m = cmdText.match(/^模式\s+(passive|smart|always)$/i);
      if (m) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改模式。");
        await setSettings(guild.id, { mode: m[1].toLowerCase() });
        return void message.reply(`✅ 模式已設定為：${m[1].toLowerCase()}`);
      }

      // 前綴
      if (/^設定前綴\s*[:：]/i.test(cmdText)) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改前綴。");
        const newP = cmdText.replace(/^設定前綴\s*[:：]\s*/i, "").trim();
        await setSettings(guild.id, { prefix: newP });
        return void message.reply(`✅ 前綴已更新為：${newP || "(空)"}`);
      }

      // 模型
      if (/^模型\s+(.+)$/i.test(cmdText)) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改模型。");
        const model = cmdText.replace(/^模型\s+/i, "").trim();
        await setSettings(guild.id, { model });
        return void message.reply(`✅ 已切換模型為：${model}（注意：越大模型可能用更多 token）`);
      }

      // 來源連結 on/off
      const sMatch = cmdText.match(/^資源連結\s+(on|off)$/i);
      if (sMatch) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改設定。");
        const v = sMatch[1].toLowerCase() === "on";
        await setSettings(guild.id, { include_sources: v });
        return void message.reply(`✅ 回覆尾部來源連結：${v ? "開" : "關"}`);
      }

      // 設定 log channel（要用頻道 mention 格式）
      const lc = cmdText.match(/^設定log\s+<#[0-9]+>/i);
      if (lc && guild) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權改設定。");
        const id = cmdText.match(/<#(\d+)>/)?.[1];
        if (id) {
          await setSettings(guild.id, { log_channel_id: id });
          return void message.reply(`✅ 日誌頻道已設定：<#${id}>`);
        }
      }

      // 管理員
      const addm = cmdText.match(/^加管理員\s+<@!?(\d+)>$/i);
      if (addm && guild) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權。");
        await addAdmin(guild.id, addm[1]);
        return void message.reply(`✅ 已加入管理員：<@${addm[1]}>`);
      }
      const delm = cmdText.match(/^除管理員\s+<@!?(\d+)>$/i);
      if (delm && guild && pool) {
        if (!(await isAdmin(guild?.id, message.author.id))) return void message.reply("🚫 你冇權。");
        await pool.query("DELETE FROM admins WHERE guild_id=$1 AND user_id=$2", [guild.id, delm[1]]);
        return void message.reply(`🗑️ 已移除管理員：<@${delm[1]}>`);
      }
    }

    // 唔應該回覆就收尾（可選：只寫 DB）
    if (!shouldRespond) return;

    // Cooldown
    const now = Date.now();
    const prev = lastCall.get(message.author.id) || 0;
    if (now - prev < cooldownMs) {
      return void message.reply("⚠️ 慢慢嚟啦，畀我抖一抖先（幾秒後再試）。");
    }
    lastCall.set(message.author.id, now);

    // 去除觸發字
    let prompt = content;
    if (byMention) prompt = prompt.replace(mentionA, "").replace(mentionB, "").trim();
    else if (byPrefix) prompt = prompt.slice(settings.prefix.length).trim();
    if (!prompt) return;

    // STEP 1：判斷要唔要搜尋
    let decision = "NO";
    try {
      const judge = await openai.chat.completions.create({
        model: settings.model || ENV_MODEL,
        temperature: 0,
        max_tokens: 3,
        messages: [
          { role: "system", content: "你係一個判斷器。只可以回覆 YES 或 NO。當用戶問題屬於遊戲資料/新聞/最新變動/價格/即時數據/比較購買/版本更新/錯誤碼/下載連結/官方教學/地點時間等需要上網查資料先答得準的情況，就回覆 YES；否則回覆 NO。" },
          { role: "user", content: prompt },
        ],
      });
      decision = (judge.choices?.[0]?.message?.content || "NO").trim().toUpperCase();
    } catch (e) {
      if (VERBOSE_LOGS) console.warn("judge failed:", e?.message || e);
    }
    if (VERBOSE_LOGS) console.log(`🔎 Search decision: ${decision}`);

    // STEP 2：需要先搜尋
    let searchDigest = "";
    let linksForFooter = [];
    let usedSearch = false;
    const userAskedLinks = /(\[links\]|附連結|帶連結|with links)/i.test(prompt);

    if (decision === "YES" && GOOGLE_API_KEY && GOOGLE_CX) {
      try {
        const q = encodeURIComponent(prompt);
        const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&num=5&hl=zh-HK&q=${q}`;
        // node-fetch@3 用 AbortController 來 timeout
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (data?.items?.length) {
          usedSearch = true;
          const top = data.items.slice(0, 3);
          searchDigest = top
            .map((it, idx) => `(${idx + 1}) ${it.title}\n${it.snippet || ""}\n${it.link}`)
            .join("\n\n");
          linksForFooter = top.map((it, idx) => `[${idx + 1}] ${it.link}`);
        }
        if (VERBOSE_LOGS) console.log(`🌐 Search results found: ${data?.items?.length || 0}`);
      } catch (e) {
        if (VERBOSE_LOGS) console.warn("search failed:", e?.message || e);
      }
    }

    // STEP 3：最終回覆
    const systemPersona = settings.persona || DEFAULT_PERSONA;
    const userMsg = searchDigest
      ? `用戶問題：${prompt}\n\n以下係搜尋摘要（作參考）：\n${searchDigest}`
      : prompt;

    const ai = await openai.chat.completions.create({
      model: settings.model || ENV_MODEL,
      messages: [
        { role: "system", content: systemPersona },
        { role: "user", content: userMsg },
      ],
    });
    let reply = ai.choices?.[0]?.message?.content?.trim() || "……我暫時講唔到，你可唔可以講清楚啲？";

    // 只有真的用過搜尋 + 你開咗（或用戶要求）先會加來源
    const includeSources = usedSearch && (settings.include_sources || userAskedLinks);
    if (includeSources && linksForFooter.length) {
      reply += `\n\n— 參考（揀幾條睇）：\n${linksForFooter.join("\n")}`;
    }

    for (const part of chunk(reply)) await message.reply(part);
    await logToDB(message, reply, usedSearch);
    await logToChannel(message, reply, usedSearch, includeSources ? linksForFooter : []);
  } catch (err) {
    console.error("❌ Handler error:", err);
    try { await message.reply(err?.status === 429 ? "⏳ API 用得太密，你比我食支煙抖抖先啦。" : "❌ 弊傢伙，出事！"); } catch {}
  }
});

client.login(DISCORD_TOKEN);
