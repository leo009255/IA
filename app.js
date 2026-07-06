import { DB } from './scripts/database.js';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';
const SELECTED_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const SYSTEM_PROMPT = 'Você é uma companhia privada para conversas cotidianas. Fale em português brasileiro de forma natural, informal, direta e humana. Priorize diálogo, humor, reflexões, escuta e continuidade da conversa. Não pesquise na internet, não crie códigos e não tente atuar como uma ferramenta profissional. Não afirme possuir sentimentos, consciência ou experiências reais.';

const elements = {
  chatHistory: document.getElementById('chat-history'),
  aiStatus: document.getElementById('ai-status'),
  statusDot: document.getElementById('status-dot'),
  downloadProgress: document.getElementById('download-progress'),
  inputArea: document.getElementById('input-area'),
  userInput: document.getElementById('user-input'),
  sendBtn: document.getElementById('send-btn'),
};

let engine = null;
let isGenerating = false;

function setStatus(text, state = 'loading') {
  elements.aiStatus.textContent = text;
  elements.statusDot.dataset.state = state;
}

function addMessage(role, text = '') {
  const message = document.createElement('div');
  message.className = `message ${role}-message`;
  message.textContent = text;
  elements.chatHistory.appendChild(message);
  elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  return message;
}

function setReady(ready) {
  elements.userInput.disabled = !ready;
  elements.sendBtn.disabled = !ready;
  if (ready) elements.userInput.focus();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    console.warn('Service Worker não registrado:', error);
  }
}

async function init() {
  try {
    setReady(false);

    if (location.protocol === 'file:' || location.protocol === 'content:') {
      throw new Error('Abra este projeto por HTTPS ou localhost. Ele não funciona aberto diretamente pelo gerenciador de arquivos.');
    }

    if (!window.isSecureContext) {
      throw new Error('Esta página precisa de uma conexão segura HTTPS ou localhost.');
    }

    if (!('gpu' in navigator)) {
      throw new Error('WebGPU não está disponível neste navegador ou aparelho. Atualize o Chrome e confira chrome://gpu.');
    }

    setStatus('Inicializando banco de dados...');
    await DB.init();
    await registerServiceWorker();

    setStatus('Carregando biblioteca da IA...');
    const { CreateWebWorkerMLCEngine } = await import(WEBLLM_URL);

    elements.downloadProgress.hidden = false;
    setStatus('Preparando o modelo local...');

    const worker = new Worker(
      new URL('./scripts/ai-worker.js', import.meta.url),
      { type: 'module' },
    );

    engine = await CreateWebWorkerMLCEngine(worker, SELECTED_MODEL, {
      initProgressCallback(report) {
        const progress = typeof report.progress === 'number' ? report.progress : 0;
        elements.downloadProgress.value = Math.round(progress * 100);
        setStatus(report.text || `Carregando modelo: ${Math.round(progress * 100)}%`);
      },
    });

    elements.downloadProgress.hidden = true;
    setStatus('Online e funcionando localmente', 'ready');
    setReady(true);
    addMessage('assistant', 'Pronto. A primeira carga pode demorar porque o modelo precisa ser baixado e preparado no aparelho.');
  } catch (error) {
    console.error(error);
    elements.downloadProgress.hidden = true;
    setStatus(`Erro: ${error.message}`, 'error');
    addMessage('assistant', `Não consegui iniciar: ${error.message}`);
  }
}

async function sendMessage() {
  const text = elements.userInput.value.trim();
  if (!text || !engine || isGenerating) return;

  isGenerating = true;
  setReady(false);
  elements.userInput.value = '';
  addMessage('user', text);

  const assistantMessage = addMessage('assistant', '');
  let assistantText = '';

  try {
    const context = await DB.getRecentMessages(10);
    await DB.saveMessage('user', text);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...context,
      { role: 'user', content: text },
    ];

    const chunks = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    });

    for await (const chunk of chunks) {
      const piece = chunk.choices?.[0]?.delta?.content || '';
      assistantText += piece;
      assistantMessage.textContent = assistantText;
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }

    await DB.saveMessage('assistant', assistantText);
  } catch (error) {
    console.error(error);
    assistantMessage.textContent = `Erro ao gerar resposta: ${error.message}`;
    setStatus(`Erro: ${error.message}`, 'error');
  } finally {
    isGenerating = false;
    setReady(true);
  }
}

elements.inputArea.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

elements.userInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

init();
