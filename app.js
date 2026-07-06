import { DB } from './scripts/database.js';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';
// Modelo menor e mais compatível para o primeiro teste no celular.
const SELECTED_MODEL = 'SmolLM2-360M-Instruct-q4f32_1-MLC';
const SYSTEM_PROMPT = 'Você é uma companhia privada para conversas cotidianas. Responda sempre em português brasileiro, de forma natural, informal, direta e bem-humorada. Priorize diálogo, escuta e continuidade. Não pesquise na internet, não crie códigos e não afirme possuir sentimentos ou consciência.';

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

function describeError(error) {
  if (error instanceof Error) {
    const details = [error.name, error.message].filter(Boolean).join(': ');
    return details || String(error);
  }
  if (typeof error === 'string') return error;
  if (error === null) return 'Erro nulo recebido durante a inicialização.';
  if (error === undefined) return 'Erro sem detalhes recebido durante a inicialização.';
  try {
    const json = JSON.stringify(error, Object.getOwnPropertyNames(error));
    return json && json !== '{}' ? json : String(error);
  } catch {
    return String(error);
  }
}

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

async function verifyWebGPU() {
  if (!window.isSecureContext) {
    throw new Error('Esta página precisa ser aberta por HTTPS.');
  }
  if (!('gpu' in navigator)) {
    throw new Error('WebGPU não está disponível neste navegador. Atualize o Chrome e confirme que não está usando navegador interno de outro aplicativo.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('O Chrome expôs a API WebGPU, mas não conseguiu criar um adaptador compatível neste aparelho. Isso normalmente indica limitação do driver, da GPU ou bloqueio do navegador.');
  }
}

async function init() {
  try {
    setReady(false);
    setStatus('Verificando WebGPU...');
    await verifyWebGPU();

    setStatus('Inicializando banco de dados...');
    await DB.init();
    await registerServiceWorker();

    setStatus('Carregando biblioteca da IA...');
    const webllm = await import(WEBLLM_URL);
    if (typeof webllm.CreateMLCEngine !== 'function') {
      throw new Error('A biblioteca WebLLM foi carregada, mas CreateMLCEngine não foi encontrado.');
    }

    elements.downloadProgress.hidden = false;
    setStatus('Preparando modelo local...');

    // A versão direta evita uma segunda camada de Web Worker durante o diagnóstico.
    engine = await webllm.CreateMLCEngine(SELECTED_MODEL, {
      initProgressCallback(report) {
        const progress = typeof report?.progress === 'number' ? report.progress : 0;
        elements.downloadProgress.value = Math.round(progress * 100);
        setStatus(report?.text || `Carregando modelo: ${Math.round(progress * 100)}%`);
      },
    });

    elements.downloadProgress.hidden = true;
    setStatus('Online e funcionando localmente', 'ready');
    setReady(true);
    addMessage('assistant', 'Pronto. O modelo está carregado no aparelho. A primeira inicialização demora mais porque os arquivos precisam ser baixados e armazenados no navegador.');
  } catch (error) {
    console.error('Falha na inicialização:', error);
    const details = describeError(error);
    elements.downloadProgress.hidden = true;
    setStatus(`Erro: ${details}`, 'error');
    addMessage('assistant', `Não consegui iniciar.\n\n${details}`);
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

    const chunks = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...context,
        { role: 'user', content: text },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 384,
    });

    for await (const chunk of chunks) {
      const piece = chunk.choices?.[0]?.delta?.content || '';
      assistantText += piece;
      assistantMessage.textContent = assistantText;
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }

    await DB.saveMessage('assistant', assistantText);
    setStatus('Online e funcionando localmente', 'ready');
  } catch (error) {
    const details = describeError(error);
    console.error('Falha ao gerar resposta:', error);
    assistantMessage.textContent = `Erro ao gerar resposta: ${details}`;
    setStatus(`Erro: ${details}`, 'error');
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
