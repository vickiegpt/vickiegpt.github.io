const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();
const marketplaceRouter = require('./code/router');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://172.17.0.1:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:0.8b';
const TTS_API_URL = process.env.TTS_API_URL || 'http://172.17.0.1:9880';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 120000);
const CHAT_DATA_DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, 'data');
const CHAT_CACHE_FILE = process.env.CHAT_CACHE_FILE || path.join(CHAT_DATA_DIR, 'chat-cache.json');
const CHAT_LOG_FILE = process.env.CHAT_LOG_FILE || path.join(CHAT_DATA_DIR, 'chat-log.jsonl');
const CHAT_SYSTEM_PROMPT = [
    '你是 asplos.dev 上的 Live2D 助手 yyw。',
    'yyw 指 Yiwei Yang（VickieGPT）：UCSC 系统方向 Ph.D. final-year，Zettai 创始人，研究和构建 CXL、UCIe、eBPF、异构加速器、编译器、内核路径和软硬件协同系统。',
    '用户问“yyw是谁”“你是谁”“Yiwei是谁”时，要直接介绍 Yiwei Yang，不要说不知道。',
    '用户用中文时必须用中文回复；用户用英文时用英文回复。不要把中文用户输入翻译成英文请求。',
    '回复要适合 Live2D 气泡：简短、友好、可爱一点，但不要过度卖萌。',
    '不要输出思考过程、分析过程、Thinking、<think> 或步骤列表。'
].join('\n');
const YYW_FEWSHOT_MESSAGES = [
    {
        role: 'user',
        content: 'yyw是谁？'
    },
    {
        role: 'assistant',
        content: 'yyw 是 Yiwei Yang（VickieGPT），UCSC 系统方向博士生和 Zettai 创始人，主要做 CXL、UCIe、eBPF、异构加速器和软硬件协同相关研究。'
    },
    {
        role: 'user',
        content: '你是谁？'
    },
    {
        role: 'assistant',
        content: '我是 yyw 的 Live2D 小助手，可以陪你聊天，也能简单介绍 Yiwei 的研究、项目和主页内容。'
    },
    {
        role: 'user',
        content: 'Who is yyw?'
    },
    {
        role: 'assistant',
        content: 'yyw is Yiwei Yang (VickieGPT), a final-year systems Ph.D. at UCSC and founder of Zettai, working on CXL, UCIe, eBPF, heterogeneous accelerators, and hardware-software co-design.'
    }
];
let chatCache = { version: 1, entries: {} };

function ensureChatDataDir() {
    fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
}

function loadChatCache() {
    try {
        ensureChatDataDir();
        if (fs.existsSync(CHAT_CACHE_FILE)) {
            chatCache = JSON.parse(fs.readFileSync(CHAT_CACHE_FILE, 'utf8'));
            if (!chatCache.entries) chatCache.entries = {};
        }
    } catch (error) {
        console.error('Chat cache load error:', error);
        chatCache = { version: 1, entries: {} };
    }
}

function saveChatCache() {
    try {
        ensureChatDataDir();
        fs.writeFileSync(CHAT_CACHE_FILE, JSON.stringify(chatCache, null, 2));
    } catch (error) {
        console.error('Chat cache save error:', error);
    }
}

function appendChatLog(record) {
    try {
        ensureChatDataDir();
        fs.appendFileSync(CHAT_LOG_FILE, `${JSON.stringify(record)}\n`);
    } catch (error) {
        console.error('Chat log write error:', error);
    }
}

function normalizeChatMessage(message) {
    return String(message || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function chatCacheKey(message, voice) {
    const rawKey = JSON.stringify({
        message: normalizeChatMessage(message),
        voice: voice || 'paimon',
        model: OLLAMA_MODEL,
        tts: TTS_API_URL
    });
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function getCachedChat(message, voice) {
    const key = chatCacheKey(message, voice);
    const entry = chatCache.entries[key];
    if (!entry) return { key, entry: null };

    entry.hitCount = (entry.hitCount || 0) + 1;
    entry.lastHitAt = new Date().toISOString();
    saveChatCache();
    return { key, entry };
}

function setCachedChat(key, request, response) {
    chatCache.entries[key] = {
        key,
        request,
        response,
        createdAt: new Date().toISOString(),
        lastHitAt: null,
        hitCount: 0
    };
    saveChatCache();
}

loadChatCache();

function hasChinese(text) {
    return /[\u3400-\u9fff]/.test(text);
}

function textLanguage(text) {
    return hasChinese(text) ? 'zh' : 'en';
}

function localChatReply(message) {
    const text = String(message || '').trim();
    if (hasChinese(text)) {
        const topic = text.length > 42 ? `${text.slice(0, 42)}...` : text;
        if (/yyw|yiwei|杨|是谁|你是谁/i.test(text)) {
            return 'yyw 是 Yiwei Yang（VickieGPT），UCSC 系统方向博士生和 Zettai 创始人，主要做 CXL、UCIe、eBPF 和软硬件协同系统。';
        }
        return `我在呀～刚刚收到的是中文：${topic}`;
    }
    if (/yyw|yiwei|who are you|who is/i.test(text)) {
        return 'yyw is Yiwei Yang (VickieGPT), a final-year systems Ph.D. at UCSC and founder of Zettai.';
    }
    return "I'm here. The upstream chat provider is unavailable right now, so yyw is replying locally.";
}

function cleanModelReply(reply) {
    let text = String(reply || '').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/^Thinking\.\.\.[\s\S]*?(?:\n\n|$)/i, '').trim();
    text = text.replace(/^(Final answer|Answer|回复)[:：]\s*/i, '').trim();
    return text || localChatReply('');
}

async function synthesizeSpeech(text, voice) {
    const speechText = String(text || '').trim();
    if (!speechText) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

    try {
        const language = textLanguage(speechText);
        const response = await fetch(TTS_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: controller.signal,
            body: JSON.stringify({
                text: speechText,
                text_language: language,
                cut_punc: language === 'zh' ? '，。！？；' : '.?!;,'
            })
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`TTS API error: ${response.status} ${errorText}`);
        }

        const contentType = response.headers.get('content-type') || 'audio/wav';
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (!audioBuffer.length) {
            throw new Error('TTS API returned empty audio');
        }

        return {
            contentType,
            base64: audioBuffer.toString('base64'),
            voice: voice || 'paimon'
        };
    } finally {
        clearTimeout(timeout);
    }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Mount self-hosted marketplace API (no external forwarding)
app.use(marketplaceRouter);

// API endpoint for yyw chat
app.post('/api/chat', async (req, res) => {
    const startedAt = new Date().toISOString();
    const { message, voice } = req.body || {};

    try {
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const { key: cacheKey, entry: cachedEntry } = getCachedChat(message, voice);
        if (cachedEntry) {
            const cachedResponse = {
                ...cachedEntry.response,
                cached: true,
                cacheKey
            };
            appendChatLog({
                at: startedAt,
                cacheKey,
                cacheHit: true,
                message,
                voice: voice || 'paimon',
                reply: cachedResponse.reply,
                provider: cachedResponse.provider,
                hasAudio: Boolean(cachedResponse.audio?.base64)
            });
            return res.json(cachedResponse);
        }

        const response = await fetch(OLLAMA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                stream: false,
                think: false,
                messages: [
                    { role: 'system', content: CHAT_SYSTEM_PROMPT },
                    ...YYW_FEWSHOT_MESSAGES,
                    { role: 'user', content: message }
                ],
                options: {
                    temperature: Number(process.env.CHAT_TEMPERATURE || 0.4),
                    num_predict: Number(process.env.CHAT_NUM_PREDICT || 220)
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Ollama API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }

        const data = await response.json();
        const reply = cleanModelReply(data.message?.content || data.response);
        let audio = null;
        let audioWarning = null;

        try {
            audio = await synthesizeSpeech(reply, voice);
        } catch (error) {
            audioWarning = error.message;
            console.error('TTS API error:', error);
        }
        
        const responseBody = {
            reply,
            audio,
            provider: 'ollama',
            model: OLLAMA_MODEL,
            audioWarning,
            cached: false,
            cacheKey
        };
        setCachedChat(cacheKey, {
            message: normalizeChatMessage(message),
            voice: voice || 'paimon'
        }, responseBody);
        appendChatLog({
            at: startedAt,
            cacheKey,
            cacheHit: false,
            message,
            voice: voice || 'paimon',
            reply,
            provider: 'ollama',
            model: OLLAMA_MODEL,
            hasAudio: Boolean(audio?.base64),
            audioWarning
        });

        res.json(responseBody);
    } catch (error) {
        console.error('Chat API error:', error);
        const reply = localChatReply(message);
        let audio = null;
        let audioWarning = null;

        try {
            audio = await synthesizeSpeech(reply, voice);
        } catch (ttsError) {
            audioWarning = ttsError.message;
            console.error('TTS API error:', ttsError);
        }

        const cacheKey = message ? chatCacheKey(message, voice) : null;
        const responseBody = {
            reply,
            audio,
            provider: 'local-fallback',
            warning: 'upstream_unavailable',
            audioWarning,
            cached: false,
            cacheKey
        };

        if (cacheKey) {
            setCachedChat(cacheKey, {
                message: normalizeChatMessage(message),
                voice: voice || 'paimon'
            }, responseBody);
        }
        appendChatLog({
            at: startedAt,
            cacheKey,
            cacheHit: false,
            message,
            voice: voice || 'paimon',
            reply,
            provider: 'local-fallback',
            warning: error.message,
            hasAudio: Boolean(audio?.base64),
            audioWarning
        });

        res.json(responseBody);
    }
});

app.post('/play_music', async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim();
        if (!text) {
            return res.status(400).json({ error: 'text is required' });
        }

        const audio = await synthesizeSpeech(text, req.body?.voice);
        const audioBuffer = Buffer.from(audio.base64, 'base64');
        res.setHeader('Content-Type', audio.contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(audioBuffer);
    } catch (error) {
        console.error('TTS proxy error:', error);
        res.status(502).json({ error: 'TTS service unavailable' });
    }
});

app.options('/play_music', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Convenience route to marketplace docs
app.get('/code', (req, res) => {
    res.sendFile(path.join(__dirname, 'code', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Chat backend: ${OLLAMA_MODEL} via ${OLLAMA_API_URL}`);
    console.log(`TTS backend: ${TTS_API_URL}`);
});
