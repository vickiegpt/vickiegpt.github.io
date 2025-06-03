let messages = {
    "body": ["大坏蛋！你都多久没理人家了呀，嘤嘤嘤～", "嗨～快来逗我玩吧！", "拿小拳拳锤你胸口！", "不要动手动脚的！快把手拿开~~", "真…真的是不知羞耻！", "Hentai！", "再摸的话我可要报警了！⌇●﹏●⌇", "110吗，这里有个变态一直在摸我(ó﹏ò｡)"]
}

// Claude API 配置 (暂时禁用 - CORS 限制)
const CLAUDE_CONFIG = {
    apiKey: '',
    apiUrl: '',
    model: '',
    maxTokens: 0
}


remind = (function () {
    let text;
    var now = new Date().getHours()
    console.log(now)
    if (now > 23 || now <= 5) {
        text = '你是夜猫子呀？这么晚还不睡觉，明天起的来嘛？';
    } else if (now > 5 && now <= 7) {
        text = '早上好！一日之计在于晨，美好的一天就要开始了！';
    } else if (now > 7 && now <= 11) {
        text = '上午好！工作顺利嘛，不要久坐，多起来走动走动哦！';
    } else if (now > 11 && now <= 14) {
        text = '中午了，工作了一个上午，现在是午餐时间！';
    } else if (now > 14 && now <= 17) {
        text = '午后很容易犯困呢，今天的运动目标完成了吗？';
    } else if (now > 17 && now <= 19) {
        text = '傍晚了！窗外夕阳的景色很美丽呢，最美不过夕阳红~~';
    } else if (now > 19 && now <= 21) {
        text = '晚上好，今天过得怎么样？';
    } else if (now > 21 && now <= 23) {
        text = '已经这么晚了呀，早点休息吧，晚安~~';
    } else {
        text = '嗨~ 快来逗我玩吧！';
    }
    showMessage(text, 2000)
});

// 绑定默认事件
window.bindDefaultEvent = () => {
    window.time = window.setInterval(remind, 1800000);
    document.touchHeadHandler = () => {
        showMessage('嗯嗯~~~', 2000)
    }
    document.touchBodyHandler = () => {
        const msg = messages.body[Math.floor(Math.random() * messages.body.length)];
        showMessage(msg, 800)
    }
}
// 绑定配置事件
window.bindConfigEvent = (config) => {
    // 绑定可选按钮事件
    if (config.warmReminder) {
        window.time = window.setInterval(remind, 1800000);
    }
    for (let i = 1; i <= 3; i++) {
        console.log('绑定', i);
        if (config[`btn${i}`] && config[`btn${i}`].trigger && config[`btn${i}`].icon) {
            console.log('绑定可选按钮事件', i);
            $(`#option${i} span`).html(config[`btn${i}`].icon)
            $(`#option${i}`).show()
            $(`#option${i}`).click(() => {
                const data = {
                    type: 'notice',
                    trigger: config[`btn${i}`].trigger,
                    code: window.code
                }
                window.ws.send(JSON.stringify(data))
            })
        }
    }
    if (config['header'] && config['header'].trigger) {
        document.touchHeadHandler = () => {
            const data = {
                type: 'notice',
                trigger: config['header'].trigger,
                code: window.code
            }
            window.ws.send(JSON.stringify(data))
        }
    } else {
        document.touchHeadHandler = () => {
            showMessage('嗯嗯~~~', 2000)
        }

    }
    if (config['body'] && config['body'].trigger) {
        document.touchBodyHandler = () => {
            let data = {
                type: 'notice',
                trigger: config['body'].trigger,
                code: window.code
            }
            window.ws.send(JSON.stringify(data))
        }
    } else {
        document.touchBodyHandler = () => {
            const msg = messages.body[Math.floor(Math.random() * messages.body.length)];
            showMessage(msg, 800)
        }
    }
}
/**
 * 显示消息框
 * @param text 文本
 * @param timeout
 */
function showMessage(text, timeout) {
    if (Array.isArray(text)) text = text[Math.floor(Math.random() * text.length + 1) - 1];
    console.log('showMessage', text);
    $('.message').stop();
    $('.message').html(text).fadeTo(200, 1);
    if (timeout === null) timeout = 5000;
    hideMessage(timeout);
}

/**
 * 隐藏消息框
 * @param timeout
 */
function hideMessage(timeout) {
    $('.message').stop().css('opacity', 1);
    if (timeout === null) timeout = 5000;
    $('.message').delay(timeout).fadeTo(200, 0);
}
// 设置宽度
window.adjustSize = (width, height) => {
    $("#landlord").height(height).width(width)
    document.getElementById("live2d").width = width;
    document.getElementById("live2d").height = height;
}
adjustSize(320, 380)

// Claude API 调用函数
async function callClaudeAPI(userMessage) {
    if (!CLAUDE_CONFIG.apiKey) {
        throw new Error('Claude API key not set. Please set your API key first.');
    }

    try {
        const response = await fetch(CLAUDE_CONFIG.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_CONFIG.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: CLAUDE_CONFIG.model,
                max_tokens: CLAUDE_CONFIG.maxTokens,
                messages: [
                    {
                        role: 'user',
                        content: userMessage
                    }
                ],
                system: '你是一个可爱的Live2D虚拟角色，请用可爱、友好的语气回复用户。回复要简洁有趣，符合二次元角色的说话风格。'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.content[0].text;
    } catch (error) {
        console.error('Claude API Error:', error);
        throw error;
    }
}

// 设置 Claude API Key
function setClaudeApiKey(apiKey) {
    localStorage.setItem('claude_api_key', apiKey);
    CLAUDE_CONFIG.apiKey = apiKey;
    showMessage('API Key 设置成功！现在可以和我聊天了～', 2000);
}

// GPT-SoVITS 语音合成配置
const VOICE_CONFIG = {
    voices: {
        paimon: {
            baseUrl: 'https://asplos.dev/play_music',
            ref_audio_path: 'samples/Paimon/疑问—哇，这个，还有这个…只是和史莱姆打了一场，就有这么多结论吗？.wav',
            prompt_text: '哇，这个，还有这个…只是和史莱姆打了一场，就有这么多结论吗？',
            prompt_language: 'zh',
            text_language: 'zh'
        },
    }
};

// 语音合成函数
async function synthesizeVoice(text, voiceType = 'paimon') {
    try {
        const voiceSettings = VOICE_CONFIG.voices[voiceType];
        if (!voiceSettings) {
            console.error('未知的语音类型:', voiceType);
            return;
        }

        const response = await fetch(`${voiceSettings.baseUrl}/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text,
                text_language: voiceSettings.text_language,
                ref_audio_path: voiceSettings.ref_audio_path,
                prompt_text: voiceSettings.prompt_text,
                prompt_language: voiceSettings.prompt_language,
                top_k: 5,
                top_p: 1,
                temperature: 1,
                cut_punc: '，。'
            })
        });

        if (response.ok) {
            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
            };

            audio.play().catch(error => {
                console.error('音频播放失败:', error);
            });
        } else {
            console.error('语音合成失败:', response.status, response.statusText);
        }
    } catch (error) {
        console.error('语音合成错误:', error);
    }
}

// 与 Claude 聊天 (模拟回复 - 避免 CORS 错误)
async function chatWithClaude(userMessage) {
    const selectedVoice = $('#voice-select').val() || 'paimon';

    const responses = {
        paimon: {
            messages: [
                '旅行者，这个问题yyw也不太懂呢～',
                '哇！听起来好有趣的样子！yyw想知道更多！',
                '唔...让yyw想想...应该是这样的吧！',
                '旅行者真厉害！yyw都要学不过来了～',
                '这个yyw知道！就像是...嗯...那个...算了，yyw忘了～',
                '哇哦！旅行者说的话yyw都听懂了呢！',
                'yyw觉得旅行者说得很对！就是这样的！',
                '嘿嘿，旅行者又在逗yyw开心了～'
            ],
            thinking: '让yyw想想...',
            name: 'yyw'
        },
        linyi: {
            messages: [
                '切，这种问题你也要问我？',
                '啧，真是麻烦死了...',
                '你这脑子是怎么长的？',
                '算了算了，我告诉你吧...',
                '这么简单的事情都不懂吗？',
                '真是服了你了，听好了...',
                '下次别问这种弱智问题',
                '我就勉强回答你一下吧'
            ],
            thinking: '让我想想怎么骂你...',
            name: '林忆'
        }
    };

    const currentChar = responses[selectedVoice];
    showMessage(currentChar.thinking, 1000);

    setTimeout(async () => {
        const randomResponse = currentChar.messages[Math.floor(Math.random() * currentChar.messages.length)];
        showMessage(randomResponse, 4000);

        // 合成并播放语音
        await synthesizeVoice(randomResponse, selectedVoice);

        // 在聊天记录中添加回复
        const chatMessages = $('#chat-messages');
        if (chatMessages.length > 0) {
            chatMessages.append(`<div style="margin-bottom: 5px; color: #ff69b4;"><strong>${currentChar.name}:</strong> ${randomResponse}</div>`);
            chatMessages.scrollTop(chatMessages[0].scrollHeight);
        }
    }, 1500);
}

// 信息框
window.receiveMsg = (msg, duration = 2000) => {
    showMessage(msg, duration)
}

// 暴露给全局使用的函数
window.setClaudeApiKey = setClaudeApiKey;
window.chatWithClaude = chatWithClaude;