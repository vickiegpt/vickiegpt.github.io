// Claude API integration
interface ClaudeMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface ClaudeCompletionOptions {
    max_tokens: number;
    temperature: number;
    top_p: number;
    top_k: number;
}

interface ClaudeProgress {
    loaded: number;
    total: number;
}

// Claude API configuration
const CHAT_API_URL = '/api/chat';
let CLAUDE_API_KEY = '';

// 设置API密钥
export function setClaudeApiKey(apiKey: string): void {
    CLAUDE_API_KEY = apiKey;
}

// 初始化Claude（模拟原来的初始化过程）
export async function initClaude(): Promise<boolean> {
    // 检查API密钥是否设置
    if (!CLAUDE_API_KEY) {
        throw new Error("请先设置Claude API密钥");
    }
    return true;
}

// 模拟模型加载（实际上Claude API不需要加载模型）
export async function loadModel(
    progressCallback: (progress: ClaudeProgress) => void
): Promise<void> {
    // 模拟加载进度
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
        progressCallback({ loaded: i, total: steps });
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// 使用后端API生成文本
export async function generateText(
    prompt: string,
    options: ClaudeCompletionOptions = {
        max_tokens: 1000,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40
    }
): Promise<string> {
    try {
        const response = await fetch(CHAT_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: prompt,
                options: options
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Chat API错误: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }

        const data = await response.json();
        return data.reply || '';
    } catch (error) {
        throw error;
    }
}

// 初始化UI事件
export function initUI(): void {
    // 获取DOM元素
    const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
    const setApiKeyBtn = document.getElementById('setApiKey') as HTMLButtonElement;
    const loadModelBtn = document.getElementById('loadModel') as HTMLButtonElement;
    const generateBtn = document.getElementById('generate') as HTMLButtonElement;
    const progressElem = document.getElementById('progress') as HTMLDivElement;
    const inputElem = document.getElementById('inputText') as HTMLTextAreaElement;
    const outputElem = document.getElementById('output') as HTMLDivElement;
    
    // 检查元素是否存在
    if (!apiKeyInput || !setApiKeyBtn || !loadModelBtn || !generateBtn || !progressElem || !inputElem || !outputElem) {
        console.error("找不到必要的DOM元素");
        return;
    }
    
    // 设置API密钥按钮事件
    setApiKeyBtn.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            progressElem.textContent = '请输入有效的API密钥！';
            return;
        }
        
        setClaudeApiKey(apiKey);
        progressElem.textContent = 'API密钥已设置，可以加载模型了';
        loadModelBtn.disabled = false;
        apiKeyInput.value = ''; // 清空输入框以保护密钥
    });
    
    // 加载模型按钮事件
    loadModelBtn.addEventListener('click', async () => {
        try {
            loadModelBtn.disabled = true;
            progressElem.textContent = '初始化Claude...';
            
            // 初始化Claude
            await initClaude();
            
            progressElem.textContent = '正在连接Claude API...';
            
            // 模拟加载过程
            await loadModel(({ loaded, total }) => {
                const progressPercentage = Math.round((loaded / total) * 100);
                progressElem.textContent = `连接中... ${progressPercentage}%`;
            });
            
            progressElem.textContent = 'Claude API已准备就绪！';
            generateBtn.disabled = false;
        } catch (error) {
            progressElem.textContent = `错误: ${error instanceof Error ? error.message : String(error)}`;
            loadModelBtn.disabled = false;
            console.error(error);
        }
    });
    
    // 生成文本按钮事件
    generateBtn.addEventListener('click', async () => {
        try {
            const inputText = inputElem.value.trim();
            if (!inputText) {
                outputElem.textContent = '请输入提示文本！';
                return;
            }
            
            generateBtn.disabled = true;
            outputElem.textContent = '生成中...';
            
            // 生成文本
            const outputText = await generateText(inputText);
            outputElem.textContent = outputText;
        } catch (error) {
            outputElem.textContent = `错误: ${error instanceof Error ? error.message : String(error)}`;
            console.error(error);
        } finally {
            generateBtn.disabled = false;
        }
    });
}

// 在DOM加载完成后初始化UI
document.addEventListener('DOMContentLoaded', initUI);