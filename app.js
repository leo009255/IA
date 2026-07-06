import { DB } from './scripts/database.js';
import { MLCEngine, CreateWebWorkerMLCEngine } from "https://esm.run/@mlc.ai/web-llm";

const elements = {
    chatHistory: document.getElementById('chat-history'),
    aiStatus: document.getElementById('ai-status'),
    downloadProgress: document.getElementById('download-progress'),
    userInput: document.getElementById('user-input'),
    sendBtn: document.getElementById('send-btn')
};

let engine = null;
let currentAssistantMessageDiv = null;
let isGenerating = false;

// Modelo maior e melhor para português (3B params, mais coerente)
const SELECTED_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

const SYSTEM_PROMPT = `Você é uma companheira de conversa chamada Luna. 
Regras absolutas:
- Responda SEMPRE em português brasileiro natural e fluido
- Seja calorosa, empática e presente na conversa
- Faça perguntas para manter o diálogo vivo
- Use humor leve quando apropriado
- NÃO repita frases estranhas ou sem sentido
- NÃO fale de cerveja, oração ou coisas aleatórias sem contexto
- Se não souber algo, seja honesta
- Mantenha respostas curtas e diretas (2-4 frases)`;

async function init() {
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('./sw.js');
        } catch (e) { console.log('SW:', e.message); }
    }

    try {
        elements.aiStatus.textContent = 'Inicializando banco de dados...';
        await DB.init();
        await loadChatHistory();

        elements.aiStatus.textContent = 'Iniciando IA (1º acesso pode demorar)...';
        elements.downloadProgress.style.display = 'block';

        await initEngine();
    } catch (error) {
        elements.aiStatus.textContent = 'Erro: ' + error.message;
    }
}

async function initEngine() {
    const initProgressCallback = (progress) => {
        elements.aiStatus.textContent = progress.text || 'Carregando...';
        if (progress.progress !== undefined) {
            elements.downloadProgress.value = Math.round(progress.progress * 100);
        }
    };

    // Tenta GPU primeiro
    try {
        const worker = new Worker(new URL('./scripts/ai-worker.js', import.meta.url), { type: 'module' });
        engine = await CreateWebWorkerMLCEngine(worker, SELECTED_MODEL, { initProgressCallback });
        elements.aiStatus.textContent = 'Online (GPU) — pronta para conversar';
        enableChat();
        return;
    } catch (gpuError) {
        console.warn('GPU falhou:', gpuError.message);
        elements.aiStatus.textContent = 'GPU não disponível, tentando CPU...';
    }

    // Fallback CPU
    try {
        engine = await MLCEngine.create(SELECTED_MODEL, { initProgressCallback });
        elements.aiStatus.textContent = 'Online (CPU) — pronta para conversar';
        enableChat();
    } catch (cpuError) {
        elements.aiStatus.textContent = 'Erro: ' + cpuError.message;
    }
}

function enableChat() {
    elements.downloadProgress.style.display = 'none';
    elements.userInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.userInput.focus();
}

async function loadChatHistory() {
    try {
        const messages = await DB.getRecentMessages(50);
        elements.chatHistory.innerHTML = '';
        for (const msg of messages) {
            const div = document.createElement('div');
            div.classList.add('message', msg.role === 'user' ? 'user-message' : 'assistant-message');
            div.textContent = msg.content;
            elements.chatHistory.appendChild(div);
        }
        elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    } catch (e) { console.error(e); }
}

async function sendMessage() {
    const text = elements.userInput.value.trim();
    if (!text || isGenerating || !engine) return;

    isGenerating = true;
    elements.userInput.value = '';
    elements.sendBtn.disabled = true;
    elements.userInput.disabled = true;

    const userDiv = document.createElement('div');
    userDiv.classList.add('message', 'user-message');
    userDiv.textContent = text;
    elements.chatHistory.appendChild(userDiv);
    elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;

    await DB.saveMessage('user', text);

    const context = await DB.getRecentMessages(10);
    const contextForAI = context.slice(0, -1);

    currentAssistantMessageDiv = document.createElement('div');
    currentAssistantMessageDiv.classList.add('message', 'assistant-message');
    elements.chatHistory.appendChild(currentAssistantMessageDiv);

    try {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...contextForAI,
            { role: "user", content: text }
        ];

        const chunks = await engine.chat.completions.create({
            messages,
            stream: true,
            temperature: 0.6,        // mais previsível, menos alucinação
            max_tokens: 256,         // respostas mais curtas e focadas
            top_p: 0.9               // mais coerente
        });

        let fullReply = "";
        for await (const chunk of chunks) {
            const textChunk = chunk.choices[0]?.delta?.content || "";
            if (textChunk) {
                fullReply += textChunk;
                currentAssistantMessageDiv.textContent = fullReply;
                elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
            }
        }

        await DB.saveMessage('assistant', fullReply);

    } catch (error) {
        currentAssistantMessageDiv.textContent = 'Erro: ' + error.message;
    } finally {
        currentAssistantMessageDiv = null;
        isGenerating = false;
        elements.sendBtn.disabled = false;
        elements.userInput.disabled = false;
        elements.userInput.focus();
    }
}

elements.sendBtn.addEventListener('click', sendMessage);
elements.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

init();
