/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./gpt/main.ts":
/*!*********************!*\
  !*** ./gpt/main.ts ***!
  \*********************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   generateText: () => (/* binding */ generateText),\n/* harmony export */   initClaude: () => (/* binding */ initClaude),\n/* harmony export */   initUI: () => (/* binding */ initUI),\n/* harmony export */   loadModel: () => (/* binding */ loadModel),\n/* harmony export */   setClaudeApiKey: () => (/* binding */ setClaudeApiKey)\n/* harmony export */ });\n// Claude API configuration\nconst CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';\nconst CORS_PROXY = 'https://cors-anywhere.herokuapp.com/';\nlet CLAUDE_API_KEY = '';\nlet useCorsProxy = false;\n// 设置API密钥\nfunction setClaudeApiKey(apiKey) {\n    CLAUDE_API_KEY = apiKey;\n}\n// 初始化Claude（模拟原来的初始化过程）\nasync function initClaude() {\n    // 检查API密钥是否设置\n    if (!CLAUDE_API_KEY) {\n        throw new Error(\"请先设置Claude API密钥\");\n    }\n    return true;\n}\n// 模拟模型加载（实际上Claude API不需要加载模型）\nasync function loadModel(progressCallback) {\n    // 模拟加载进度\n    const steps = 10;\n    for (let i = 0; i <= steps; i++) {\n        progressCallback({ loaded: i, total: steps });\n        await new Promise(resolve => setTimeout(resolve, 100));\n    }\n}\n// 使用Claude API生成文本\nasync function generateText(prompt, options = {\n    max_tokens: 1000,\n    temperature: 0.5,\n    top_p: 0.9,\n    top_k: 40\n}) {\n    if (!CLAUDE_API_KEY) {\n        throw new Error(\"API密钥未设置\");\n    }\n    // Try direct API call first, fallback to CORS proxy\n    let apiUrl = CLAUDE_API_URL;\n    let headers = {\n        'Content-Type': 'application/json',\n        'x-api-key': CLAUDE_API_KEY,\n        'anthropic-version': '2023-06-01'\n    };\n    // If CORS proxy is needed, modify URL and headers\n    if (useCorsProxy) {\n        apiUrl = CORS_PROXY + CLAUDE_API_URL;\n        headers = {\n            ...headers,\n            'X-Requested-With': 'XMLHttpRequest'\n        };\n    }\n    try {\n        const response = await fetch(apiUrl, {\n            method: 'POST',\n            headers,\n            body: JSON.stringify({\n                model: 'claude-3-sonnet-20240229',\n                max_tokens: options.max_tokens,\n                temperature: options.temperature,\n                top_p: options.top_p,\n                top_k: options.top_k,\n                messages: [\n                    {\n                        role: 'user',\n                        content: prompt\n                    }\n                ]\n            })\n        });\n        if (!response.ok) {\n            // If direct call fails with CORS, try with proxy\n            if (!useCorsProxy && response.status === 0) {\n                useCorsProxy = true;\n                return generateText(prompt, options);\n            }\n            const errorData = await response.json().catch(() => ({}));\n            throw new Error(`Claude API错误: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);\n        }\n        const data = await response.json();\n        return data.content[0]?.text || '';\n    }\n    catch (error) {\n        // If direct call fails with CORS error, try with proxy\n        if (!useCorsProxy && error instanceof TypeError && error.message.includes('CORS')) {\n            useCorsProxy = true;\n            return generateText(prompt, options);\n        }\n        throw error;\n    }\n}\n// 初始化UI事件\nfunction initUI() {\n    // 获取DOM元素\n    const apiKeyInput = document.getElementById('apiKey');\n    const setApiKeyBtn = document.getElementById('setApiKey');\n    const loadModelBtn = document.getElementById('loadModel');\n    const generateBtn = document.getElementById('generate');\n    const progressElem = document.getElementById('progress');\n    const inputElem = document.getElementById('inputText');\n    const outputElem = document.getElementById('output');\n    // 检查元素是否存在\n    if (!apiKeyInput || !setApiKeyBtn || !loadModelBtn || !generateBtn || !progressElem || !inputElem || !outputElem) {\n        console.error(\"找不到必要的DOM元素\");\n        return;\n    }\n    // 设置API密钥按钮事件\n    setApiKeyBtn.addEventListener('click', () => {\n        const apiKey = apiKeyInput.value.trim();\n        if (!apiKey) {\n            progressElem.textContent = '请输入有效的API密钥！';\n            return;\n        }\n        setClaudeApiKey(apiKey);\n        progressElem.textContent = 'API密钥已设置，可以加载模型了';\n        loadModelBtn.disabled = false;\n        apiKeyInput.value = ''; // 清空输入框以保护密钥\n    });\n    // 加载模型按钮事件\n    loadModelBtn.addEventListener('click', async () => {\n        try {\n            loadModelBtn.disabled = true;\n            progressElem.textContent = '初始化Claude...';\n            // 初始化Claude\n            await initClaude();\n            progressElem.textContent = '正在连接Claude API...';\n            // 模拟加载过程\n            await loadModel(({ loaded, total }) => {\n                const progressPercentage = Math.round((loaded / total) * 100);\n                progressElem.textContent = `连接中... ${progressPercentage}%`;\n            });\n            progressElem.textContent = 'Claude API已准备就绪！';\n            generateBtn.disabled = false;\n        }\n        catch (error) {\n            progressElem.textContent = `错误: ${error instanceof Error ? error.message : String(error)}`;\n            loadModelBtn.disabled = false;\n            console.error(error);\n        }\n    });\n    // 生成文本按钮事件\n    generateBtn.addEventListener('click', async () => {\n        try {\n            const inputText = inputElem.value.trim();\n            if (!inputText) {\n                outputElem.textContent = '请输入提示文本！';\n                return;\n            }\n            generateBtn.disabled = true;\n            outputElem.textContent = '生成中...';\n            // 生成文本\n            const outputText = await generateText(inputText);\n            outputElem.textContent = outputText;\n        }\n        catch (error) {\n            outputElem.textContent = `错误: ${error instanceof Error ? error.message : String(error)}`;\n            console.error(error);\n        }\n        finally {\n            generateBtn.disabled = false;\n        }\n    });\n}\n// 在DOM加载完成后初始化UI\ndocument.addEventListener('DOMContentLoaded', initUI);\n\n\n//# sourceURL=webpack://victoryang00.github.io/./gpt/main.ts?");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	var __webpack_exports__ = {};
/******/ 	__webpack_modules__["./gpt/main.ts"](0, __webpack_exports__, __webpack_require__);
/******/ 	
/******/ })()
;