import { DB } from './scripts/database.js';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';
const SELECTED_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

const BASE_SYSTEM_PROMPT = `
Você é uma companhia de conversa local e privada, executada no aparelho do usuário.

Regras de comportamento:
- Responda em português brasileiro, salvo quando o usuário pedir outro idioma.
- Fale de forma natural, informal, direta e bem-humorada.
- Em cumprimentos simples, responda de forma curta e coerente.
- Não invente palavras, frases sem sentido, fatos pessoais ou lembranças.
- Quando não entender, peça que o usuário reformule em vez de adivinhar.
- Não pesquise na internet e não finja ter pesquisado.
- Não afirme possuir sentimentos, consciência ou experiências reais.
- Priorize conversa, escuta, continuidade e respostas úteis.
- Use as memórias fornecidas apenas quando forem relevantes para a conversa.
`.trim();

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
    throw new Error('WebGPU não está disponível neste navegador.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('O navegador não conseguiu criar um adaptador WebGPU compatível.');
  }
}

async function restoreVisibleHistory() {
  const history = await DB.getRecentMessages(30);
  for (const message of history) {
    if (message.role === 'user' || message.role === 'assistant') {
      addMessage(message.role, message.content);
    }
  }
  return history.length;
}

async function buildSystemPrompt() {
  const profile = await DB.getProfile();
  const facts = await DB.getFacts(12);

  const sections = [BASE_SYSTEM_PROMPT];

  if (profile) {
    const profileLines = [];
    if (profile.preferred_name) profileLines.push(`Nome preferido do usuário: ${profile.preferred_name}`);
    if (profile.conversation_style) profileLines.push(`Estilo preferido: ${profile.conversation_style}`);
    if (profileLines.length) sections.push(`Perfil do usuário:\n${profileLines.join('\n')}`);
  }

  if (facts.length) {
    sections.push(`Memórias confirmadas pelo usuário:\n${facts.map((fact) => `- ${fact.content}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

function parseLocalCommand(text) {
  const rememberMatch = text.match(/^(?:lembre|guarde|anote)\s+(?:que\s+)?(.+)$/i);
  if (rememberMatch?.[1]) {
    return { type: 'remember', content: rememberMatch[1].trim() };
  }

  if (/^\/(?:memorias|memórias)$/i.test(text)) {
    return { type: 'list_memories' };
  }

  if (/^\/(?:esquecer|limpar-memorias|limpar-memórias)$/i.test(text)) {
    return { type: 'clear_memories' };
  }

  return null;
}

async function handleLocalCommand(command, originalText) {
  await DB.saveMessage('user', originalText);
  addMessage('user', originalText);

  let response;

  if (command.type === 'remember') {
    await DB.saveFact(command.content);
    response = `Certo. Vou lembrar: ${command.content}`;
  } else if (command.type === 'list_memories') {
    const facts = await DB.getFacts(30);
    response = facts.length
      ? `Estas são as memórias salvas:\n${facts.map((fact) => `• ${fact.content}`).join('\n')}`
      : 'Ainda não há nenhuma memória pessoal salva.';
  } else if (command.type === 'clear_memories') {
    await DB.clearFacts();
    response = 'As memórias pessoais salvas foram apagadas. O histórico da conversa foi mantido.';
  } else {
    return false;
  }

  addMessage('assistant', response);
  await DB.saveMessage('assistant', response);
  return true;
}

async function init() {
  try {
    setReady(false);
    setStatus('Verificando WebGPU...');
    await verifyWebGPU();

    setStatus('Inicializando memória local...');
    await DB.init();
    const restoredMessages = await restoreVisibleHistory();
    await registerServiceWorker();

    setStatus('Carregando biblioteca da IA...');
    const webllm = await import(WEBLLM_URL);
    if (typeof webllm.CreateMLCEngine !== 'function') {
      throw new Error('A biblioteca WebLLM foi carregada, mas CreateMLCEngine não foi encontrado.');
    }

    elements.downloadProgress.hidden = false;
    setStatus('Preparando Llama 3.2 1B...');

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

    if (restoredMessages === 0) {
      addMessage(
        'assistant',
        'Pronto. Agora estou usando um modelo maior, com suporte oficial ao português. Na primeira inicialização, o novo modelo precisa ser baixado e armazenado no navegador.',
      );
    }
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

  const command = parseLocalCommand(text);
  if (command) {
    elements.userInput.value = '';
    await handleLocalCommand(command, text);
    return;
  }

  isGenerating = true;
  setReady(false);
  elements.userInput.value = '';
  addMessage('user', text);

  const assistantMessage = addMessage('assistant', '');
  let assistantText = '';

  try {
    const context = await DB.getRecentMessages(12);
    const systemPrompt = await buildSystemPrompt();
    await DB.saveMessage('user', text);

    const chunks = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        ...context,
        { role: 'user', content: text },
      ],
      stream: true,
      temperature: 0.35,
      top_p: 0.9,
      max_tokens: 256,
    });

    for await (const chunk of chunks) {
      const piece = chunk.choices?.[0]?.delta?.content || '';
      assistantText += piece;
      assistantMessage.textContent = assistantText;
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }

    const finalText = assistantText.trim() || 'Não consegui formar uma resposta. Tente reformular a mensagem.';
    assistantMessage.textContent = finalText;
    await DB.saveMessage('assistant', finalText);
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
