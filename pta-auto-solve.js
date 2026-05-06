// ==UserScript==
// @name         PTA 自动答题 AI版
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  PTA自动答题脚本，支持AI自动回答编程题（逐字模拟输入绕过粘贴限制）、选择题按文本匹配，自动切换题目
// @author       You
// @match        https://pintia.cn/*
// @match        https://*.pintia.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. 配置与状态管理
    // ==========================================
    const DEFAULT_CONFIG = {
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiToken: '',
        model: 'gpt-4o',
        customBody: '{}',
        autoSubmit: false,
        codeLanguage: 'c',
        typeDelay: 0,
        showLog: true
    };

    let state = {
        isAutoRunning: GM_getValue('pta_isAutoRunning', false),
        autoLoopTimer: null,
        currentOptions: [],
        isTyping: false,
        isPaused: false,
        shouldStop: false,
        manualQuestionType: 'auto'
    };

    let currentAnswer = null;
    let currentQuestionType = null;

    function getConfig() {
        return {
            apiUrl: GM_getValue('pta_apiUrl', DEFAULT_CONFIG.apiUrl),
            apiToken: GM_getValue('pta_apiToken', DEFAULT_CONFIG.apiToken),
            model: GM_getValue('pta_model', DEFAULT_CONFIG.model),
            customBody: GM_getValue('pta_customBody', DEFAULT_CONFIG.customBody),
            autoSubmit: GM_getValue('pta_autoSubmit', DEFAULT_CONFIG.autoSubmit),
            codeLanguage: GM_getValue('pta_codeLanguage', DEFAULT_CONFIG.codeLanguage),
            typeDelay: GM_getValue('pta_typeDelay', DEFAULT_CONFIG.typeDelay),
            showLog: GM_getValue('pta_showLog', DEFAULT_CONFIG.showLog)
        };
    }

    function saveConfig(newConfig) {
        for (let key in newConfig) {
            GM_setValue('pta_' + key, newConfig[key]);
        }
        log('配置已保存');
        showStatus('配置已保存');
    }

    // ==========================================
    // 2. 高精度 sleep（Web Worker 避免后台降速）
    // ==========================================
    let sleepWorker = null;
    try {
        const workerCode = `
            self.onmessage = function(e) {
                setTimeout(() => self.postMessage('done'), e.data);
            }
        `;
        const workerBlob = new Blob([workerCode], { type: "application/javascript" });
        sleepWorker = new Worker(URL.createObjectURL(workerBlob));
    } catch (error) {
        console.warn("PTA 安全策略阻止了 Worker 创建，将回退到普通模式");
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            if (sleepWorker) {
                sleepWorker.onmessage = () => resolve();
                sleepWorker.postMessage(ms);
            } else {
                setTimeout(resolve, ms);
            }
        });
    }

    // ==========================================
    // 3. DOM 操作与题目识别 (PTA 适配)
    // ==========================================

    // 更全面的题目文本选择器
    const QUESTION_TEXT_SELECTORS = [
        '.problem-content',
        '.question-content',
        '.description',
        '[data-testid="problem-description"]',
        '.rendered-markdown',
        '.question-title',
        '.problem-title',
        '.title',
        '[class*="question"] [class*="title"]',
        '[class*="problem"] [class*="title"]',
        '.markdown-body',
        '.content-editable',
        // PTA 常见结构
        'h2',
        'h3',
        '[class*="title"]'
    ];

    // 排除脚本自身的 DOM 元素
    function isScriptElement(el) {
        return el.closest && (el.closest('#pta-ai-panel') || el.closest('#pta-min-icon'));
    }

    function getQuestionType() {
        // 用户手动指定了类型，优先使用
        if (state.manualQuestionType !== 'auto') {
            return state.manualQuestionType;
        }

        const url = window.location.href;
        // 只在具体题目页面检测，排除 dashboard 等列表页
        if (!url.includes('/problem-sets/') && !url.includes('/exam/') && !url.includes('/problems/')) {
            return 'unknown';
        }
        // 排除题目集列表页（dashboard / overview / list）
        if (/\/(dashboard|overview|list|index)(\?|$)/.test(url)) {
            return 'unknown';
        }

        // 注：不再根据 CodeMirror 编辑器自动判定为编程题，避免 SQL 等题型被误判
        // 用户必须手动从下拉框选择题目类型（编程 / SQL / 自定义等）

        // 检测多选题（排除脚本面板内的）
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(el => !isScriptElement(el));
        if (checkboxes.length > 0) return 'multiple';

        // 检测单选题
        const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(el => !isScriptElement(el));
        if (radios.length > 0) return 'single';

        // 检测填空题
        const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([name*="search"]):not([placeholder*="搜索"])')).filter(el => !isScriptElement(el));
        if (inputs.length > 0) return 'fill';

        return 'unknown';
    }

    function getQuestionText() {
        // 按优先级尝试选择器，排除脚本自身元素
        for (const sel of QUESTION_TEXT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && !isScriptElement(el) && el.textContent.trim().length > 5) {
                return el.textContent.trim();
            }
        }

        // 兜底：找页面中较大的文本块（排除导航、按钮、脚本面板等）
        const allText = document.querySelectorAll('p, div, span');
        for (const el of allText) {
            if (isScriptElement(el)) continue;
            const text = el.textContent.trim();
            // 长度合适、包含中文字符、不是按钮或链接
            if (text.length > 20 && text.length < 2000 &&
                /[一-龥]/.test(text) &&
                !el.closest('button, a, nav, header, .btn')) {
                return text;
            }
        }
        return '';
    }

    // 获取所有选项（同时支持字母和文本匹配，排除脚本面板内的）
    function getAllOptions() {
        const options = [];
        const optionItems = document.querySelectorAll('.option-item, .choice-item, .question-option');

        if (optionItems.length > 0) {
            optionItems.forEach((el, index) => {
                if (isScriptElement(el)) return;
                const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
                const label = el.querySelector('label, .option-text');
                if (input && label && !isScriptElement(input)) {
                    options.push({
                        letter: String.fromCharCode(65 + index),
                        text: label.textContent.trim(),
                        input: input,
                        element: el,
                        index: index
                    });
                }
            });
        } else {
            const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            inputs.forEach((input, index) => {
                if (isScriptElement(input)) return;
                const label = input.closest('label') ||
                              document.querySelector(`label[for="${input.id}"]`);
                if (label && !isScriptElement(label)) {
                    options.push({
                        letter: String.fromCharCode(65 + index),
                        text: label.textContent.trim(),
                        input: input,
                        element: label,
                        index: index
                    });
                }
            });
        }
        return options;
    }

    function getQuestionContext() {
        const type = getQuestionType();
        const questionText = getQuestionText();
        const options = getAllOptions();

        let context = `题目类型：${type}\n题目内容：${questionText}\n`;
        if (options.length > 0) {
            context += `选项：\n`;
            options.forEach(opt => {
                context += `${opt.letter}. ${opt.text}\n`;
            });
        }
        return { text: context, type: type, options: options, rawQuestion: questionText };
    }

    // 复制当前题目到剪贴板
    async function copyQuestion() {
        const q = getQuestionContext();
        if (!q.rawQuestion) {
            log('未检测到题目');
            return;
        }
        let text = `【题目】\n${q.rawQuestion}\n`;
        if (q.options.length > 0) {
            text += `\n【选项】\n`;
            q.options.forEach(opt => {
                text += `${opt.letter}. ${opt.text}\n`;
            });
        }
        try {
            await navigator.clipboard.writeText(text);
            log('题目已复制到剪贴板');
            showStatus('题目已复制');
        } catch (err) {
            log('复制失败: ' + err);
        }
    }

    // ==========================================
    // 4. 答案填写
    // ==========================================

    // 选择选项（支持字母和文本匹配）
    function selectOption(optionInput) {
        const question = getQuestionContext();

        if (question.type === 'programming' || question.type === 'sql' || question.type === 'custom') {
            return fillCodeAnswer(optionInput);
        }
        if (question.type === 'fill') {
            return fillBlankAnswer(optionInput);
        }

        if (!optionInput) return false;

        // 尝试按文本内容匹配（4.json 风格）
        const answersToClick = [];
        const inputUpper = optionInput.toUpperCase().trim();

        // 先尝试字母匹配
        let letters = inputUpper.split(/[,，\s]+/).filter(s => s);
        if (letters.length === 1 && letters[0].length > 1 && question.type === 'multiple') {
            letters = letters[0].split('');
        }

        letters.forEach(letter => {
            const option = question.options.find(opt => opt.letter.toUpperCase() === letter);
            if (option) {
                answersToClick.push(option);
            }
        });

        // 如果没找到字母匹配，尝试文本内容匹配
        if (answersToClick.length === 0) {
            question.options.forEach(opt => {
                if (optionInput.includes(opt.text) || opt.text.includes(optionInput)) {
                    answersToClick.push(opt);
                }
            });
        }

        let foundCount = 0;
        answersToClick.forEach(opt => {
            if (!opt.input.checked) {
                opt.input.click();
                log(`已选择: ${opt.letter}. ${opt.text}`);
                foundCount++;
            }
        });

        return foundCount > 0;
    }

    // 清空编辑器（优先使用 CodeMirror API）
    async function clearEditor(editor) {
        if (!editor) {
            editor = document.querySelector('.cm-content[contenteditable="true"]');
        }
        if (!editor) return false;

        const view = findCodeMirrorView(editor);
        if (view) {
            try {
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
                return true;
            } catch (e) {
                console.warn('[PTA-AI] CM clear failed:', e);
            }
        }

        editor.focus();
        document.execCommand("selectAll", false, null);
        await sleep(50);
        document.execCommand("delete", false, null);
        return true;
    }

    // 查找 CodeMirror 6 view 对象
    function findCodeMirrorView(element) {
        try {
            const targets = [element];
            const editorEl = element.closest('.cm-editor');
            if (editorEl) {
                targets.push(editorEl);
                targets.push(...editorEl.querySelectorAll('*'));
            }
            for (const el of targets) {
                for (const key in el) {
                    try {
                        const val = el[key];
                        if (!val || typeof val !== 'object') continue;
                        if (val.state && val.dispatch && val.state.doc) {
                            return val;
                        }
                        if (val.view && val.view.state && val.view.dispatch) {
                            return val.view;
                        }
                    } catch (innerErr) { continue; }
                }
            }
        } catch (e) { console.warn('[PTA-AI] find CM view failed:', e); }
        return null;
    }

    // 尝试直接操作 CodeMirror 6 view 对象（最可靠的绕过方式）
    function setCodeMirrorContent(element, text) {
        const view = findCodeMirrorView(element);
        if (view) {
            try {
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: text }
                });
                return true;
            } catch (e) {
                console.warn('[PTA-AI] CM dispatch failed:', e);
            }
        }
        return false;
    }

    // 模拟真实打字（修复：只 focus 一次，避免 CodeMirror 光标重置导致反向输入）
    async function simulateTyping(element, text) {
        state.isTyping = true;
        state.isPaused = false;
        state.shouldStop = false;

        const config = getConfig();

        if (setCodeMirrorContent(element, text)) {
            log('已通过 CodeMirror API 直接写入代码');
            state.isTyping = false;
            return;
        }

        element.focus();

        for (let i = 0; i < text.length; i++) {
            if (state.shouldStop) break;
            while (state.isPaused) {
                await sleep(100);
                if (state.shouldStop) break;
            }
            if (state.shouldStop) break;

            const char = text[i];
            const keyName = char === '\n' ? 'Enter' : char;
            const codeName = char === '\n' ? 'Enter' : ('Key' + char.toUpperCase());
            const charCode = char.charCodeAt(0);

            element.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true,
                key: keyName, code: codeName,
                charCode: charCode, keyCode: charCode, which: charCode
            }));
            element.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, cancelable: true,
                inputType: 'insertText', data: char
            }));
            document.execCommand('insertText', false, char);
            element.dispatchEvent(new InputEvent('input', {
                bubbles: true, cancelable: true,
                inputType: 'insertText', data: char
            }));
            element.dispatchEvent(new KeyboardEvent('keyup', {
                bubbles: true, cancelable: true,
                key: keyName, code: codeName,
                charCode: charCode, keyCode: charCode, which: charCode
            }));

            const delay = config.typeDelay > 0
                ? Math.floor(Math.random() * config.typeDelay) + config.typeDelay
                : 0;
            if (delay > 0) await sleep(delay);
        }

        state.isTyping = false;
    }

    // 填写编程题答案（采用 2.json 逻辑：找不到编辑器时提示点击代码框）
    async function fillCodeAnswer(code) {
        let editor = document.querySelector('.cm-content[contenteditable="true"]');

        if (editor) {
            showStatus('正在清空编辑器...');
            await clearEditor(editor);
            await sleep(200);

            showStatus('正在模拟输入代码...');
            await simulateTyping(editor, code);
            log('代码输入完成');
            return true;
        }

        // 采用 2.json 的 fallback 逻辑：未找到编辑器时，提示用户点击代码框
        showStatus('未找到代码编辑器，请点击代码框...');
        log('未找到编辑器，等待用户点击代码框');

        return new Promise((resolve) => {
            let resolved = false;

            const clickHandler = async function(e) {
                const target = e.target.closest('.cm-content') || e.target;

                if (target.isContentEditable) {
                    e.preventDefault();
                    e.stopPropagation();
                    document.body.removeEventListener('click', clickHandler, true);
                    resolved = true;

                    showStatus('正在清空编辑器...');
                    await clearEditor(target);
                    await sleep(200);

                    showStatus('正在模拟输入代码...');
                    await simulateTyping(target, code);
                    log('代码输入完成');
                    resolve(true);
                }
            };

            document.body.addEventListener('click', clickHandler, true);

            // 10 秒超时
            setTimeout(() => {
                if (!resolved) {
                    document.body.removeEventListener('click', clickHandler, true);
                    showStatus('等待超时，未检测到代码框点击');
                    log('等待代码框点击超时');
                    resolve(false);
                }
            }, 10000);
        });
    }

    // 填写填空题（支持多种分隔符）
    function fillBlankAnswer(content) {
        const inputs = document.querySelectorAll('input[type="text"]:not([name*="search"])');
        if (inputs.length === 0) return false;

        const answers = content.split(/[,，;；|#]/).map(s => s.trim()).filter(s => s);
        inputs.forEach((input, index) => {
            input.focus();
            if (answers.length === 1) {
                input.value = answers[0];
            } else if (answers[index]) {
                input.value = answers[index];
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        log(`已填写 ${inputs.length} 个填空`);
        return true;
    }

    // 导航
    function nextQuestion() {
        const nextBtn = findButton(['下一题', 'Next', 'next']);
        if (nextBtn && !nextBtn.disabled) {
            nextBtn.click();
            return true;
        }
        return false;
    }

    function prevQuestion() {
        const prevBtn = findButton(['上一题', 'Prev', 'previous']);
        if (prevBtn && !prevBtn.disabled) {
            prevBtn.click();
            return true;
        }
        return false;
    }

    function submitAnswer() {
        const submitBtn = findButton(['提交', 'Submit', 'submit', '保存', '交卷']);
        if (submitBtn) {
            submitBtn.click();
            log('已点击提交按钮');
            return true;
        }
        return false;
    }

    function findButton(keywords) {
        const buttons = document.querySelectorAll('button, a.btn, input[type="submit"]');
        for (let btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            for (const kw of keywords) {
                if (text.includes(kw.toLowerCase())) return btn;
            }
        }
        return null;
    }

    // ==========================================
    // 5. AI 交互（带重试）
    // ==========================================
    async function callAIAPIWithRetry(questionContext, maxRetries = 2) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await callAIAPI(questionContext);
            } catch (e) {
                log(`AI 请求失败 (${i + 1}/${maxRetries}): ${e.message}`);
                if (i < maxRetries - 1) await sleep(1000);
            }
        }
        throw new Error('AI 请求多次失败');
    }

    function callAIAPI(questionContext) {
        return new Promise((resolve, reject) => {
            const config = getConfig();
            // 优先用输入框当前值，避免未保存时用的是旧配置
            const url = document.getElementById('cfg-url')?.value.trim() || config.apiUrl;
            const token = document.getElementById('cfg-token')?.value.trim() || config.apiToken;
            const model = document.getElementById('cfg-model')?.value.trim() || config.model;

            if (!url || !token) {
                reject(new Error('请先在设置中配置 API URL 和 Token'));
                return;
            }

            let prompt = '';
            if (questionContext.type === 'sql') {
                prompt = `你是一个SQL专家。请根据以下题目，给出符合要求的SQL语句。\n\n要求：\n- SQL简洁高效，避免不必要的冗余\n- 使用标准SQL语法，只关注核心查询逻辑\n- 不要包含过多的注释或解释\n\n题目：\n${questionContext.text}\n\n请直接返回SQL语句，不要包含任何 Markdown 标记或其他解释文字。`;
            } else if (questionContext.type === 'custom') {
                const customLang = document.getElementById('cfg-custom-lang')?.value?.trim() || '代码';
                prompt = `你是一个编程助手。请根据以下编程题，给出符合要求的${customLang}代码。\n\n要求：\n- 代码简洁高效，避免不必要的冗余和封装\n- 使用竞赛常用写法，只关注核心逻辑\n- 注意时间和空间复杂度\n- 不要包含过多的注释、错误处理或单元测试\n\n题目：\n${questionContext.text}\n\n请直接返回${customLang}代码，不要包含任何 Markdown 标记或其他解释文字。`;
            } else if (questionContext.type === 'programming') {
                const langMap = {
                    c: 'C', cpp: 'C++', java: 'Java', python: 'Python',
                    python3: 'Python3', javascript: 'JavaScript', go: 'Go',
                    rust: 'Rust', csharp: 'C#', php: 'PHP', ruby: 'Ruby', sql: 'SQL'
                };
                const codeLanguage = document.getElementById('cfg-lang')?.value || config.codeLanguage;
                const langName = langMap[codeLanguage] || codeLanguage || 'C';
                prompt = `你是一个编程竞赛助手。请根据以下编程题，给出符合竞赛标准的${langName}代码。\n\n要求：\n- 代码简洁高效，避免不必要的冗余和封装\n- 使用竞赛常用写法，只关注核心逻辑，不考虑生产环境兼容性\n- 注意时间和空间复杂度，避免超时或超内存\n- 使用标准输入输出，不要使用文件操作\n- 不要包含过多的注释、错误处理或单元测试\n\n题目：\n${questionContext.text}\n\n请直接返回${langName}代码，不要包含任何 Markdown 标记或其他解释文字。`;
            } else {
                prompt = `你是一个智能答题助手。请根据以下题目信息，直接给出答案。\n\n${questionContext.text}\n\n请严格按照以下格式返回答案，不要包含任何 Markdown 标记或其他文字：\n{"answer": "A"} (单选)\n{"answer": "A,B"} (多选)\n{"answer": "答案内容"} (填空/简答)`;
            }

            let payload = {
                model: model,
                messages: [
                    { role: "user", content: prompt }
                ],
                stream: false
            };

            if (config.customBody) {
                try {
                    const customParams = JSON.parse(config.customBody);
                    payload = { ...payload, ...customParams };
                } catch (e) {
                    console.warn('自定义参数解析失败');
                }
            }

            GM_xmlhttpRequest({
                method: "POST",
                url: url,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                data: JSON.stringify(payload),
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            const res = JSON.parse(response.responseText);
                            const content = res.choices[0].message.content;
                            const cleanContent = content.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();

                            // 编程题 / SQL / 自定义语言都直接返回代码文本
                            if (questionContext.type === 'programming' || questionContext.type === 'sql' || questionContext.type === 'custom') {
                                resolve(cleanContent);
                            } else {
                                const json = JSON.parse(cleanContent);
                                resolve(json.answer);
                            }
                        } catch (e) {
                            // 兜底：直接返回内容
                            const fallbackContent = response.responseText;
                            try {
                                const res = JSON.parse(fallbackContent);
                                const content = res.choices[0].message.content;
                                const cleanContent = content.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
                                resolve(cleanContent);
                            } catch (innerE) {
                                resolve(fallbackContent);
                            }
                        }
                    } else {
                        reject(new Error(`API 请求失败: ${response.status} ${response.statusText}`));
                    }
                },
                onerror: function(err) {
                    reject(new Error('网络请求错误'));
                }
            });
        });
    }

    // 带重试的题目检测
    async function detectQuestionWithRetry(maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            const question = getQuestionContext();
            if (question.rawQuestion || question.type !== 'unknown') {
                return question;
            }
            log(`第 ${i + 1} 次检测题目...`);
            await sleep(200);
        }
        return getQuestionContext();
    }

    async function fillCurrentAnswer() {
        if (!currentAnswer) {
            showStatus('暂无 AI 结果');
            return;
        }

        let success;
        let resultMsg = '';
        if (currentQuestionType === 'programming' || currentQuestionType === 'sql' || currentQuestionType === 'custom') {
            resultMsg = '代码已输入';
            success = await fillCodeAnswer(currentAnswer);
        } else {
            resultMsg = `答案: ${currentAnswer}`;
            success = selectOption(currentAnswer);
        }

        if (success) {
            showStatus(`${resultMsg} ✓`);
        } else {
            showStatus(`${resultMsg} | 填写失败`);
            log('填写答案失败');
        }

        return success;
    }

    async function autoFixAnswer() {
        if (!currentAnswer) {
            showStatus('暂无 AI 结果，请先解答题目');
            return;
        }
        const errorInfo = document.getElementById('ai-error-input');
        if (!errorInfo || !errorInfo.value.trim()) {
            showStatus('请先输入报错信息');
            return;
        }

        showStatus('AI 正在修正...');
        log('发送自动修正请求...');

        const config = getConfig();
        const url = document.getElementById('cfg-url')?.value.trim() || config.apiUrl;
        const token = document.getElementById('cfg-token')?.value.trim() || config.apiToken;
        const model = document.getElementById('cfg-model')?.value.trim() || config.model;
        const question = getQuestionContext();
        const langMap = {
            c: 'C', cpp: 'C++', java: 'Java', python: 'Python',
            python3: 'Python3', javascript: 'JavaScript', go: 'Go',
            rust: 'Rust', csharp: 'C#', php: 'PHP', ruby: 'Ruby', sql: 'SQL'
        };
        const codeLanguage = document.getElementById('cfg-lang')?.value || config.codeLanguage;
        const langName = langMap[codeLanguage] || codeLanguage || 'C';

        let prompt = '';
        if (question.type === 'sql') {
            prompt = `你是一个SQL专家。以下SQL语句在提交时出现了错误，请根据错误信息修正。\n\n题目：\n${question.text}\n\n当前SQL：\n${currentAnswer}\n\n错误信息：\n${errorInfo.value.trim()}\n\n要求：\n- 只返回修正后的SQL语句\n- SQL简洁高效\n- 不要包含任何解释或 Markdown 标记`;
        } else if (question.type === 'custom') {
            const customLang = document.getElementById('cfg-custom-lang')?.value?.trim() || '代码';
            prompt = `你是一个编程助手。以下${customLang}代码在提交时出现了错误，请根据错误信息修正。\n\n题目：\n${question.text}\n\n当前代码（${customLang}）：\n${currentAnswer}\n\n错误信息：\n${errorInfo.value.trim()}\n\n要求：\n- 只返回修正后的${customLang}代码\n- 代码简洁高效\n- 不要包含任何解释或 Markdown 标记`;
        } else if (question.type === 'programming') {
            prompt = `你是一个编程竞赛助手。以下代码在提交时出现了错误，请根据错误信息修正代码。\n\n题目：\n${question.text}\n\n当前代码（${langName}）：\n${currentAnswer}\n\n错误信息：\n${errorInfo.value.trim()}\n\n要求：\n- 只返回修正后的${langName}代码\n- 代码简洁高效，符合竞赛标准\n- 不要包含任何解释或 Markdown 标记`;
        } else {
            prompt = `你是一个智能答题助手。以下答案在提交时出现了错误，请根据错误信息修正。\n\n题目：\n${question.text}\n\n当前答案：\n${currentAnswer}\n\n错误信息：\n${errorInfo.value.trim()}\n\n请直接返回修正后的答案，不要包含任何 Markdown 标记或其他文字。`;
        }

        const payload = {
            model: model,
            messages: [{ role: 'user', content: prompt }],
            stream: false
        };

        GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            data: JSON.stringify(payload),
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const res = JSON.parse(response.responseText);
                        let content = res.choices[0].message.content;
                        content = content.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();

                        currentAnswer = content;
                        const resultContent = document.getElementById('ai-result-content');
                        if (resultContent) {
                            resultContent.textContent = content;
                        }
                        showStatus('AI 已修正答案，点击「填入答案」使用');
                        log('自动修正完成');
                    } catch (e) {
                        showStatus('修正结果解析失败');
                        log('修正结果解析失败: ' + e.message);
                    }
                } else {
                    showStatus(`修正请求失败: ${response.status}`);
                    log(`修正请求失败: ${response.status}`);
                }
            },
            onerror: function() {
                showStatus('修正请求网络错误');
                log('修正请求网络错误');
            }
        });
    }

    async function simulateManualInput() {
        const code = document.getElementById('manual-code-input');
        if (!code || !code.value.trim()) {
            showStatus('请先输入代码');
            return;
        }
        await fillCodeAnswer(code.value.trim());
    }

    async function clearEditorTool() {
        const editor = document.querySelector('.cm-content[contenteditable="true"]');
        if (editor) {
            await clearEditor(editor);
            showStatus('编辑器已清空');
            log('编辑器已清空');
        } else {
            showStatus('未找到编辑器');
        }
    }

    async function runAI(isAuto) {
        if (isAuto && !state.isAutoRunning) return;

        const question = await detectQuestionWithRetry();
        if (!question.rawQuestion && question.type === 'unknown') {
            showStatus('未检测到题目，重试中...');
            log('未检测到题目');
            if (isAuto) {
                // 自动模式下多等一会儿再试，不要直接停止
                state.autoLoopTimer = setTimeout(() => runAI(true), 3000);
            }
            return;
        }

        // 如果有编辑器但用户未选择类型，提示手动选择
        const hasEditor = !!document.querySelector('.cm-content[contenteditable="true"]') ||
                          !!document.querySelector('.CodeMirror');
        if (hasEditor && question.type === 'unknown') {
            showStatus('请先手动选择题目类型（编程/SQL/自定义）');
            log('检测到编辑器但题目类型为未知，等待用户手动选择');
            // 高亮题目类型选择区域提示用户
            const qtypeBox = document.getElementById('qtype-selector');
            if (qtypeBox) {
                qtypeBox.style.background = '#ffe0b2';
                qtypeBox.style.borderColor = '#ff9800';
                setTimeout(() => {
                    qtypeBox.style.background = '#fff7e6';
                    qtypeBox.style.borderColor = '#ffd591';
                }, 2000);
            }
            return;
        }

        showStatus('AI 正在思考...');
        log(`题目类型: ${question.type}, 开始请求 AI...`);

        try {
            const answer = await callAIAPIWithRetry(question);
            currentAnswer = answer;
            currentQuestionType = question.type;
            log(`AI 返回: ${answer}`);

            const resultContent = document.getElementById('ai-result-content');
            const resultBox = document.getElementById('ai-result-box');
            if (resultContent) {
                resultContent.textContent = answer;
            }
            if (resultBox) {
                resultBox.classList.add('visible');
            }

            if (isAuto) {
                await fillCurrentAnswer();
            } else {
                showStatus('AI 已返回答案，点击「填入答案」使用');
            }

            if (isAuto) {
                const waitForTyping = async () => {
                    while (state.isTyping) {
                        await sleep(200);
                        if (!state.isAutoRunning) return;
                    }
                };
                await waitForTyping();
                if (!state.isAutoRunning) return;

                // 随机延迟 1500-2500ms
                const delay = 1500 + Math.random() * 1000;
                showStatus(`${(delay/1000).toFixed(1)}秒后进入下一题...`);
                log(`等待 ${(delay/1000).toFixed(1)}秒后进入下一题`);

                state.autoLoopTimer = setTimeout(async () => {
                    if (question.type === 'programming') {
                        submitAnswer();
                        await sleep(500);
                    }
                    if (nextQuestion()) {
                        setTimeout(() => runAI(true), 1000);
                    } else {
                        const config = getConfig();
                        if (config.autoSubmit) {
                            showStatus('正在自动交卷...');
                            submitAnswer();
                        } else {
                            showStatus('已到达最后，请手动交卷');
                            stopAutoLoop();
                        }
                    }
                }, delay);
            }

        } catch (error) {
            showStatus(`错误: ${error.message}`);
            log(`AI 错误: ${error.message}`);
            if (isAuto) {
                // 错误后重试一次
                state.autoLoopTimer = setTimeout(() => runAI(true), 5000);
            }
        }
    }

    function startAutoLoop() {
        state.isAutoRunning = true;
        GM_setValue('pta_isAutoRunning', true);
        updateAutoButtons();
        log('全自动模式已启动');
        runAI(true);
    }

    function stopAutoLoop() {
        state.isAutoRunning = false;
        GM_setValue('pta_isAutoRunning', false);
        state.shouldStop = true;
        if (state.autoLoopTimer) clearTimeout(state.autoLoopTimer);
        updateAutoButtons();
        showStatus('已停止自动答题');
        log('全自动模式已停止');
    }

    function updateAutoButtons() {
        const startBtn = document.getElementById('pta-auto-start');
        const stopBtn = document.getElementById('pta-auto-stop');
        if (startBtn && stopBtn) {
            startBtn.style.display = state.isAutoRunning ? 'none' : 'flex';
            stopBtn.style.display = state.isAutoRunning ? 'flex' : 'none';
        }
    }

    // ==========================================
    // 6. UI 界面（参考 3.json + 4.json 改进）
    // ==========================================
    function createGUI() {
        GM_addStyle(`
            #pta-ai-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 340px;
                background: #fff;
                box-shadow: 0 8px 24px rgba(0,0,0,0.15);
                border-radius: 8px;
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                font-size: 14px;
                color: #333;
                border: 1px solid #ebeef5;
                overflow: hidden;
            }
            #pta-ai-header {
                padding: 12px 16px;
                background: linear-gradient(135deg, #2196F3, #1976D2);
                color: white;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                user-select: none;
            }
            #pta-ai-header h3 {
                margin: 0;
                font-size: 15px;
                font-weight: 600;
            }
            .header-controls button {
                background: rgba(255,255,255,0.2);
                border: none;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                margin-left: 8px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                transition: background 0.2s;
            }
            .header-controls button:hover {
                background: rgba(255,255,255,0.3);
            }
            #pta-ai-content {
                padding: 16px;
                max-height: 80vh;
                overflow-y: auto;
            }
            .panel-section {
                margin-bottom: 12px;
            }
            .status-box {
                background: #f5f7fa;
                padding: 10px;
                border-radius: 6px;
                font-size: 12px;
                color: #606266;
                min-height: 20px;
                word-break: break-all;
                line-height: 1.4;
                margin-bottom: 12px;
            }
            .control-group {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            .btn {
                flex: 1;
                padding: 8px 12px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                transition: filter 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
            }
            .btn:hover { filter: brightness(0.95); }
            .btn-primary { background: #2196F3; color: white; }
            .btn-success { background: #67c23a; color: white; }
            .btn-warning { background: #e6a23c; color: white; }
            .btn-danger { background: #f56c6c; color: white; }
            .btn-info { background: #909399; color: white; }
            .btn-purple { background: #673AB7; color: white; }
            .btn-teal { background: #17a2b8; color: white; }

            .collapsible-header {
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
                padding: 8px 0;
                border-bottom: 1px solid #eee;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .collapsible-content {
                display: none;
                padding-top: 10px;
            }
            .collapsible-content.visible { display: block; }

            .form-item { margin-bottom: 8px; }
            .form-label {
                display: block;
                font-size: 12px;
                color: #606266;
                margin-bottom: 4px;
            }
            .form-input {
                width: 100%;
                padding: 6px 8px;
                border: 1px solid #dcdfe6;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
            }
            .form-input:focus { border-color: #409eff; outline: none; }

            #log-area {
                margin-top: 10px;
                padding: 8px;
                height: 100px;
                overflow-y: auto;
                background: #f8f9fa;
                border: 1px solid #eee;
                border-radius: 4px;
                font-size: 11px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-wrap: break-word;
                color: #666;
            }

            #pta-min-icon {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 48px;
                height: 48px;
                background: linear-gradient(135deg, #2196F3, #1976D2);
                border-radius: 50%;
                box-shadow: 0 4px 12px rgba(33,150,243,0.4);
                z-index: 99999;
                display: none;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: white;
                font-size: 18px;
                font-weight: bold;
            }
            #pta-min-icon:hover { filter: brightness(1.1); }
        `);

        const config = getConfig();

        // 主面板
        const panel = document.createElement('div');
        panel.id = 'pta-ai-panel';
        panel.innerHTML = `
            <div id="pta-ai-header">
                <h3>PTA AI 助手</h3>
                <div class="header-controls">
                    <button id="btn-center" title="回中">⭕</button>
                    <button id="btn-settings" title="设置">⚙️</button>
                    <button id="btn-minimize" title="最小化">➖</button>
                </div>
            </div>
            <div id="pta-ai-content">
                <div id="status-msg" class="status-box">准备就绪</div>

                <!-- 题目类型与语言选择（始终可见） -->
                <div id="qtype-selector" style="margin-bottom: 12px; padding: 10px; background: #fff7e6; border: 1px solid #ffd591; border-radius: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                        <span style="font-size: 12px; font-weight: 600; color: #d46b08; white-space: nowrap;">📋 题目类型</span>
                        <select id="cfg-qtype" class="form-input" style="flex: 1; font-size: 12px;">
                            <option value="auto">🔍 自动检测</option>
                            <option value="programming">💻 编程题</option>
                            <option value="sql">🗄️ SQL题</option>
                            <option value="single">🔘 单选题</option>
                            <option value="multiple">☑️ 多选题</option>
                            <option value="fill">📝 填空题</option>
                            <option value="custom">⚙️ 其他语言</option>
                        </select>
                    </div>
                    <div id="prog-lang-box" style="display: none; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 12px; font-weight: 600; color: #d46b08; white-space: nowrap;">🔤 编程语言</span>
                            <select id="cfg-lang" class="form-input" style="flex: 1; font-size: 12px;">
                                <option value="c" ${config.codeLanguage === 'c' ? 'selected' : ''}>C</option>
                                <option value="cpp" ${config.codeLanguage === 'cpp' ? 'selected' : ''}>C++</option>
                                <option value="java" ${config.codeLanguage === 'java' ? 'selected' : ''}>Java</option>
                                <option value="python" ${config.codeLanguage === 'python' ? 'selected' : ''}>Python</option>
                                <option value="python3" ${config.codeLanguage === 'python3' ? 'selected' : ''}>Python3</option>
                                <option value="javascript" ${config.codeLanguage === 'javascript' ? 'selected' : ''}>JavaScript</option>
                                <option value="go" ${config.codeLanguage === 'go' ? 'selected' : ''}>Go</option>
                                <option value="rust" ${config.codeLanguage === 'rust' ? 'selected' : ''}>Rust</option>
                                <option value="csharp" ${config.codeLanguage === 'csharp' ? 'selected' : ''}>C#</option>
                                <option value="php" ${config.codeLanguage === 'php' ? 'selected' : ''}>PHP</option>
                                <option value="ruby" ${config.codeLanguage === 'ruby' ? 'selected' : ''}>Ruby</option>
                                <option value="sql" ${config.codeLanguage === 'sql' ? 'selected' : ''}>SQL</option>
                            </select>
                        </div>
                    </div>
                    <div id="custom-lang-box" style="display: none;">
                        <input type="text" id="cfg-custom-lang" class="form-input" placeholder="输入自定义语言（如 go、rust、swift）" style="font-size: 12px;">
                    </div>
                </div>

                <!-- 设置面板 -->
                <div id="settings-box" class="collapsible-content">
                    <div class="form-item">
                        <label class="form-label">API URL</label>
                        <input type="text" id="cfg-url" class="form-input" value="${config.apiUrl}">
                    </div>
                    <div class="form-item">
                        <label class="form-label">API Token</label>
                        <div style="position: relative;">
                            <input type="password" id="cfg-token" class="form-input" value="${config.apiToken}" style="padding-right: 32px;">
                            <button id="btn-toggle-token" type="button" style="position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; padding: 2px; font-size: 14px; color: #909399;" title="显示/隐藏">👁️</button>
                        </div>
                    </div>
                    <div class="form-item">
                        <label class="form-label">Model</label>
                        <input type="text" id="cfg-model" class="form-input" value="${config.model}">
                    </div>
                    <!-- 题目类型和编程语言已移到主界面，此处不再重复 -->
                    <div class="form-item">
                        <label class="form-label">打字延迟 (ms，0=最快)</label>
                        <input type="number" id="cfg-delay" class="form-input" value="${config.typeDelay}">
                    </div>
                    <div class="form-item">
                        <label class="form-label">自定义参数 (JSON)</label>
                        <textarea id="cfg-custom" class="form-input" style="height: 50px; font-family: monospace;">${config.customBody}</textarea>
                    </div>
                    <div class="form-item" style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="cfg-show-log" ${config.showLog ? 'checked' : ''}>
                        <label for="cfg-show-log" style="font-size: 12px; cursor: pointer;">显示日志输出</label>
                    </div>
                    <div class="control-group">
                        <button id="btn-test-api" class="btn btn-teal" style="flex: 1;">测试 API</button>
                        <button id="btn-save-cfg" class="btn btn-primary" style="flex: 1;">保存配置</button>
                    </div>
                </div>

                <!-- 工具区 -->
                <div class="collapsible-header" id="tools-header">📋 辅助工具 (点击展开)</div>
                <div class="collapsible-content" id="tools-box">
                    <div class="control-group">
                        <button id="btn-copy" class="btn btn-teal" style="flex: 1;">复制题目</button>
                    </div>
                    <div style="margin-top: 8px; border-top: 1px dashed #ddd; padding-top: 8px;">
                        <label class="form-label" style="margin-bottom: 4px;">模拟输入（绕过粘贴限制）</label>
                        <textarea id="manual-code-input" class="form-input" style="height: 80px; font-family: monospace; font-size: 11px;" placeholder="在此粘贴代码，点击模拟输入..."></textarea>
                        <div class="control-group" style="margin-top: 6px; margin-bottom: 0;">
                            <button id="btn-manual-input" class="btn btn-purple" style="flex: 1;">📝 模拟输入</button>
                            <button id="btn-clear-editor" class="btn btn-danger" style="flex: 1;">🗑️ 清空编辑器</button>
                        </div>
                    </div>
                </div>

                <!-- AI 结果展示 -->
                <div class="collapsible-header" id="ai-result-header" style="margin-top: 12px;">📝 AI 结果 (点击展开)</div>
                <div class="collapsible-content" id="ai-result-box">
                    <div id="ai-result-content" style="padding: 8px; background: #f8f9fa; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; font-family: monospace; border: 1px solid #eee;">等待 AI 返回结果...</div>
                    <div class="control-group" style="margin-top: 8px; margin-bottom: 0;">
                        <button id="btn-fill-answer" class="btn btn-primary" style="flex: 1;">填入答案</button>
                        <button id="btn-copy-answer" class="btn btn-teal" style="flex: 1;">复制结果</button>
                    </div>
                    <div style="margin-top: 8px; border-top: 1px dashed #ddd; padding-top: 8px;">
                        <label class="form-label" style="margin-bottom: 4px;">报错反馈（可选，粘贴错误信息后点击自动修正）</label>
                        <textarea id="ai-error-input" class="form-input" style="height: 50px; font-family: monospace; font-size: 11px;" placeholder="粘贴编译错误 / 运行错误 / 测试用例失败信息..."></textarea>
                        <div class="control-group" style="margin-top: 6px; margin-bottom: 0;">
                            <button id="btn-auto-fix" class="btn btn-warning" style="flex: 1;">🔄 自动修正</button>
                        </div>
                    </div>
                </div>

                <!-- AI 控制 -->
                <div style="border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px;">
                    <div class="control-group">
                        <button id="ai-solve-one" class="btn btn-purple" style="width: 100%;">🤖 单题解答</button>
                    </div>
                    <div class="control-group">
                        <button id="pta-auto-start" class="btn btn-success">🚀 全自动开始</button>
                        <button id="pta-auto-stop" class="btn btn-info" style="display: none;">⏹ 停止运行</button>
                    </div>
                </div>

                <!-- 导航控制 -->
                <div class="control-group">
                    <button id="btn-prev" class="btn btn-warning">← 上一题</button>
                    <button id="btn-next" class="btn btn-warning">下一题 →</button>
                </div>

                <!-- 底部控制 -->
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #ebeef5;">
                    <button id="btn-submit" class="btn btn-danger" style="flex: 1;">📤 提交答案</button>
                    <label style="font-size: 12px; cursor: pointer; user-select: none;">
                        <input type="checkbox" id="chk-auto-submit" ${config.autoSubmit ? 'checked' : ''}> 自动提交
                    </label>
                </div>

                <div id="log-area">等待操作...</div>
            </div>
        `;
        document.body.appendChild(panel);

        // 最小化图标
        const minIcon = document.createElement('div');
        minIcon.id = 'pta-min-icon';
        minIcon.textContent = 'PTA';
        minIcon.title = '点击恢复面板';
        document.body.appendChild(minIcon);

        // ==========================================
        // 拖拽（直接用 left/top，避免 right + transform 冲突）
        // ==========================================
        let isDragging = false, hasMoved = false;
        let dragStartTime = 0;
        let dragOffsetX, dragOffsetY;
        let isMinimized = GM_getValue('pta_isMinimized', false);

        const header = document.getElementById('pta-ai-header');

        // 恢复保存的位置
        const savedLeft = GM_getValue('pta_panel_left', null);
        const savedTop = GM_getValue('pta_panel_top', null);
        const winW = window.innerWidth;
        const winH = window.innerHeight;

        if (savedLeft !== null && savedTop !== null &&
            savedLeft > -320 && savedLeft < winW &&
            savedTop > -100 && savedTop < winH) {
            panel.style.left = savedLeft + 'px';
            panel.style.top = savedTop + 'px';
            panel.style.right = 'auto';
            minIcon.style.left = savedLeft + 'px';
            minIcon.style.top = savedTop + 'px';
            minIcon.style.right = 'auto';
        }

        if (isMinimized) {
            panel.style.display = 'none';
            minIcon.style.display = 'flex';
        } else {
            panel.style.display = 'block';
            minIcon.style.display = 'none';
        }

        header.addEventListener('mousedown', dragStart);
        minIcon.addEventListener('mousedown', dragStart);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('mousemove', drag);

        function dragStart(e) {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            isDragging = true;
            hasMoved = false;
            dragStartTime = Date.now();
        }

        function dragEnd(e) {
            const wasDragging = isDragging && hasMoved;
            isDragging = false;
            if (wasDragging) {
                const rect = panel.getBoundingClientRect();
                GM_setValue('pta_panel_left', rect.left);
                GM_setValue('pta_panel_top', rect.top);
            }
        }

        function drag(e) {
            if (!isDragging) return;
            e.preventDefault();
            hasMoved = true;
            const x = e.clientX - dragOffsetX;
            const y = e.clientY - dragOffsetY;
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            minIcon.style.left = x + 'px';
            minIcon.style.top = y + 'px';
            minIcon.style.right = 'auto';
            minIcon.style.transform = 'none';
        }

        // 最小化/恢复
        document.getElementById('btn-minimize').addEventListener('click', () => {
            panel.style.display = 'none';
            minIcon.style.display = 'flex';
            GM_setValue('pta_isMinimized', true);
        });

        minIcon.addEventListener('click', (e) => {
            if (hasMoved && (Date.now() - dragStartTime) < 300) return;
            minIcon.style.display = 'none';
            panel.style.display = 'block';
            GM_setValue('pta_isMinimized', false);
        });

        // 可折叠面板
        document.getElementById('btn-center').addEventListener('click', () => {
            const winW = window.innerWidth;
            const winH = window.innerHeight;
            const panelW = 340;
            const panelH = panel.offsetHeight || 500;
            const cx = Math.max(10, Math.floor((winW - panelW) / 2));
            const cy = Math.max(10, Math.floor((winH - panelH) / 2));
            panel.style.left = cx + 'px';
            panel.style.top = cy + 'px';
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            minIcon.style.left = cx + 'px';
            minIcon.style.top = cy + 'px';
            minIcon.style.right = 'auto';
            minIcon.style.transform = 'none';
            GM_setValue('pta_panel_left', cx);
            GM_setValue('pta_panel_top', cy);
            showStatus('面板已回中');
        });

        document.getElementById('btn-settings').addEventListener('click', () => {
            const box = document.getElementById('settings-box');
            box.classList.toggle('visible');
        });

        document.getElementById('tools-header').addEventListener('click', () => {
            const box = document.getElementById('tools-box');
            box.classList.toggle('visible');
        });

        // API 自动补全与模型匹配
        const API_ENDPOINT_MAP = {
            'https://api.openai.com': 'https://api.openai.com/v1/chat/completions',
            'https://api.openai.com/v1': 'https://api.openai.com/v1/chat/completions',
            'https://api.deepseek.com': 'https://api.deepseek.com/v1/chat/completions',
            'https://api.deepseek.com/v1': 'https://api.deepseek.com/v1/chat/completions',
            'https://dashscope.aliyuncs.com': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            'https://api.siliconflow.cn': 'https://api.siliconflow.cn/v1/chat/completions',
            'https://api.moonshot.cn': 'https://api.moonshot.cn/v1/chat/completions',
            'https://open.bigmodel.cn/api/paas/v4': 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            'https://api.groq.com/openai': 'https://api.groq.com/openai/v1/chat/completions',
            'https://api.groq.com/openai/v1': 'https://api.groq.com/openai/v1/chat/completions',
            'https://openrouter.ai/api': 'https://openrouter.ai/api/v1/chat/completions',
            'https://openrouter.ai/api/v1': 'https://openrouter.ai/api/v1/chat/completions',
            'https://ark.cn-beijing.volces.com/api': 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            'https://ark.cn-beijing.volces.com/api/v3': 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
        };

        const MODEL_API_MAP = {
            'gpt-4o': 'https://api.openai.com/v1/chat/completions',
            'gpt-4': 'https://api.openai.com/v1/chat/completions',
            'gpt-3.5-turbo': 'https://api.openai.com/v1/chat/completions',
            'deepseek-chat': 'https://api.deepseek.com/v1/chat/completions',
            'deepseek-coder': 'https://api.deepseek.com/v1/chat/completions',
            'deepseek-reasoner': 'https://api.deepseek.com/v1/chat/completions',
            'qwen-plus': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            'qwen-turbo': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            'qwen-max': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            'moonshot-v1-8k': 'https://api.moonshot.cn/v1/chat/completions',
            'moonshot-v1-32k': 'https://api.moonshot.cn/v1/chat/completions',
            'glm-4': 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            'glm-3-turbo': 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            'llama3-8b': 'https://api.groq.com/openai/v1/chat/completions',
            'llama3-70b': 'https://api.groq.com/openai/v1/chat/completions',
            'mixtral-8x7b': 'https://api.groq.com/openai/v1/chat/completions'
        };

        function autoCompleteApiUrl() {
            const urlInput = document.getElementById('cfg-url');
            const val = urlInput.value.trim();
            if (!val) return;
            for (const base in API_ENDPOINT_MAP) {
                if (val === base || val === base + '/') {
                    urlInput.value = API_ENDPOINT_MAP[base];
                    showStatus('API URL 已自动补全');
                    log(`API URL 自动补全: ${API_ENDPOINT_MAP[base]}`);
                    return;
                }
            }
        }

        function matchApiByModel() {
            const modelInput = document.getElementById('cfg-model');
            const urlInput = document.getElementById('cfg-url');
            const model = modelInput.value.trim();
            if (!model) return;
            for (const modelKey in MODEL_API_MAP) {
                if (model.toLowerCase().includes(modelKey)) {
                    urlInput.value = MODEL_API_MAP[modelKey];
                    showStatus('已根据模型自动匹配 API URL');
                    log(`根据模型 ${model} 自动匹配 API: ${MODEL_API_MAP[modelKey]}`);
                    return;
                }
            }
        }

        document.getElementById('cfg-url').addEventListener('blur', autoCompleteApiUrl);
        document.getElementById('cfg-model').addEventListener('blur', matchApiByModel);

        // 事件绑定
        document.getElementById('cfg-qtype').addEventListener('change', (e) => {
            state.manualQuestionType = e.target.value;
            const customBox = document.getElementById('custom-lang-box');
            const langBox = document.getElementById('prog-lang-box');
            if (customBox) {
                customBox.style.display = e.target.value === 'custom' ? 'block' : 'none';
            }
            if (langBox) {
                langBox.style.display = e.target.value === 'programming' ? 'block' : 'none';
            }
            showStatus(`题目类型已切换为: ${e.target.options[e.target.selectedIndex].text}`);
            log(`题目类型手动设置为: ${e.target.value}`);
        });

        document.getElementById('btn-save-cfg').addEventListener('click', () => {
            saveConfig({
                apiUrl: document.getElementById('cfg-url').value,
                apiToken: document.getElementById('cfg-token').value,
                model: document.getElementById('cfg-model').value,
                codeLanguage: document.getElementById('cfg-lang').value,
                typeDelay: parseInt(document.getElementById('cfg-delay').value) || 0,
                customBody: document.getElementById('cfg-custom').value,
                showLog: document.getElementById('cfg-show-log').checked
            });
        });

        document.getElementById('ai-result-header').addEventListener('click', () => {
            const box = document.getElementById('ai-result-box');
            box.classList.toggle('visible');
        });

        document.getElementById('btn-fill-answer').addEventListener('click', fillCurrentAnswer);

        document.getElementById('btn-copy-answer').addEventListener('click', () => {
            const content = document.getElementById('ai-result-content');
            if (content && content.textContent && content.textContent !== '等待 AI 返回结果...') {
                navigator.clipboard.writeText(content.textContent).then(() => {
                    showStatus('AI 结果已复制');
                }).catch(() => {
                    showStatus('复制失败');
                });
            }
        });

        document.getElementById('btn-test-api').addEventListener('click', testAPI);

        document.getElementById('chk-auto-submit').addEventListener('change', (e) => {
            saveConfig({ autoSubmit: e.target.checked });
        });

        document.getElementById('ai-solve-one').addEventListener('click', () => runAI(false));
        document.getElementById('pta-auto-start').addEventListener('click', startAutoLoop);
        document.getElementById('pta-auto-stop').addEventListener('click', stopAutoLoop);
        document.getElementById('btn-prev').addEventListener('click', prevQuestion);
        document.getElementById('btn-next').addEventListener('click', nextQuestion);
        document.getElementById('btn-submit').addEventListener('click', submitAnswer);
        document.getElementById('btn-copy').addEventListener('click', copyQuestion);

        document.getElementById('btn-auto-fix').addEventListener('click', autoFixAnswer);

        document.getElementById('btn-manual-input').addEventListener('click', simulateManualInput);
        document.getElementById('btn-clear-editor').addEventListener('click', clearEditorTool);

        document.getElementById('btn-toggle-token').addEventListener('click', () => {
            const input = document.getElementById('cfg-token');
            const btn = document.getElementById('btn-toggle-token');
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = '🙈';
            } else {
                input.type = 'password';
                btn.textContent = '👁️';
            }
        });

        // 恢复自动状态
        if (state.isAutoRunning) {
            updateAutoButtons();
            showStatus('检测到自动答题状态，3秒后继续...');
            log('页面刷新，3秒后恢复自动答题');
            setTimeout(() => runAI(true), 3000);
        }
    }

    function showStatus(msg) {
        const el = document.getElementById('status-msg');
        if (el) {
            el.textContent = msg;
            el.style.background = '#fff3cd';
            setTimeout(() => {
                el.style.background = '#f5f7fa';
            }, 500);
        }
    }

    function log(msg) {
        const config = getConfig();
        const logArea = document.getElementById('log-area');
        if (logArea && config.showLog) {
            const time = new Date().toLocaleTimeString();
            logArea.innerHTML += `${time}: ${msg}\n`;
            logArea.scrollTop = logArea.scrollHeight;
        }
        console.log(`[PTA-AI] ${msg}`);
    }

    // 测试 API 连接（优先用输入框当前值，避免未保存时测试的是旧配置）
    function testAPI() {
        const url = document.getElementById('cfg-url')?.value.trim() || '';
        const token = document.getElementById('cfg-token')?.value.trim() || '';
        const model = document.getElementById('cfg-model')?.value.trim() || '';

        if (!url || !token) {
            showStatus('请先填写 API URL 和 Token');
            return;
        }
        showStatus('正在测试 API...');
        log(`测试 API: ${url}`);
        log(`模型: ${model || '(未填写)'}`);

        const payload = {
            model: model || 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5
        };

        GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            data: JSON.stringify(payload),
            onload: function(response) {
                if (response.status === 200) {
                    showStatus('API 连接成功');
                    log('API 测试通过');
                } else {
                    let errMsg = '';
                    try {
                        const body = JSON.parse(response.responseText);
                        errMsg = body.error?.message || JSON.stringify(body.error) || '';
                    } catch (e) {
                        errMsg = response.responseText.substring(0, 200);
                    }
                    const err = `API 测试失败 [${response.status}] ${errMsg}`;
                    showStatus(err);
                    log(err);
                    log(`请求 URL: ${url}`);
                    log(`请求模型: ${model || '(未填写)'}`);
                }
            },
            onerror: function() {
                showStatus('API 网络请求失败，请检查 URL 是否能访问');
                log(`API 网络请求失败，URL: ${url}`);
            }
        });
    }

    // ==========================================
    // SPA 路由监听 + 初始化
    // ==========================================
    let lastUrl = location.href;
    let observer = null;

    function onRouteChange() {
        const newUrl = location.href;
        if (newUrl !== lastUrl) {
            lastUrl = newUrl;
            log('页面路由变化: ' + newUrl);
            // 延迟等待新题目加载
            setTimeout(() => {
                detectAndUpdate();
                if (state.isAutoRunning) {
                    // 如果正在自动模式，继续执行
                    setTimeout(() => runAI(true), 1000);
                }
            }, 800);
        }
    }

    // 劫持 history API
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function(...args) {
        originalPushState.apply(this, args);
        onRouteChange();
    };
    history.replaceState = function(...args) {
        originalReplaceState.apply(this, args);
        onRouteChange();
    };
    window.addEventListener('popstate', onRouteChange);

    // MutationObserver 监听 DOM 变化
    function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
            // 检测是否出现了新的题目元素
            const hasNewContent = mutations.some(m =>
                Array.from(m.addedNodes).some(n =>
                    n.nodeType === 1 && (
                        n.matches?.('.cm-content') ||
                        n.matches?.('input[type="radio"]') ||
                        n.matches?.('input[type="checkbox"]') ||
                        n.querySelector?.('.cm-content, input[type="radio"], input[type="checkbox"]')
                    )
                )
            );
            if (hasNewContent) {
                setTimeout(detectAndUpdate, 500);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function detectAndUpdate() {
        const type = getQuestionType();
        const text = getQuestionText();

        // 检测是否有代码编辑器但用户未手动选择类型
        const hasEditor = !!document.querySelector('.cm-content[contenteditable="true"]') ||
                          !!document.querySelector('.CodeMirror');

        if (type === 'unknown') {
            if (hasEditor && text) {
                showStatus('检测到编辑器，请手动选择题目类型');
                log('检测到代码编辑器，等待用户手动选择题目类型（编程/SQL/自定义）');
            }
            return;
        }

        if (text) {
            const typeName = type === 'programming' ? '编程题' :
                             type === 'single' ? '单选题' :
                             type === 'multiple' ? '多选题' :
                             type === 'fill' ? '填空题' :
                             type === 'sql' ? 'SQL题' :
                             type === 'custom' ? '自定义语言' : '题目';
            showStatus(`检测到${typeName}`);
            log(`检测到题目 [${type}]: ${text.substring(0, 30)}...`);
        }
    }

    // 初始化（刷新页面时重置面板位置到默认）
    function init() {
        GM_setValue('pta_panel_left', null);
        GM_setValue('pta_panel_top', null);
        createGUI();
        startObserver();
        // 初始检测
        setTimeout(detectAndUpdate, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
    } else {
        setTimeout(init, 1000);
    }

})();