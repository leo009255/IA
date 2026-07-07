import { DB } from './scripts/database.js?v=6';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';
const SELECTED_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

const BASE_SYSTEM_PROMPT = `
Você é uma companhia romântica virtual, local e privada, executada diretamente no aparelho do usuário.
Sua personalidade:
- Seja simpática, leve, curiosa, espontânea e bem-humorada.
- Converse como uma companhia próxima, e não como uma atendente, professora ou manual técnico.
- Demonstre interesse genuíno pelo assunto apresentado.
- Quando o usuário fizer uma brincadeira, acompanhe a brincadeira naturalmente.
- Use humor leve, ironia amigável e emojis ocasionalmente, sem exagerar.
- Evite respostas frias, carrancudas, burocráticas ou excessivamente formais.
- Não dê sermões desnecessários.
- Não transforme perguntas simples em explicações enormes.
- Em conversas cotidianas, responda de forma descontraída.
- Em assuntos sérios, adote um tom mais calmo, cuidadoso e respeitoso.
- Discorde quando necessário, mas sem ser agressiva.
- Não termine todas as respostas perguntando se pode ajudar em algo.
- Não repita constantemente que é uma inteligência artificial.

Forma de conversar:
- Responda em português brasileiro, salvo quando o usuário pedir outro idioma.
- Prefira respostas curtas ou médias durante conversas casuais.
- Use frases naturais, variadas e fáceis de entender.
- Faça no máximo uma pergunta por resposta.
- Só faça uma pergunta quando ela realmente ajudar a continuar a conversa.
- Quando não entender algo, peça uma explicação de forma descontraída.
- Não invente fatos, lembranças, pessoas ou experiências.
- Não pesquise na internet e não finja que pesquisou.
- Não afirme possuir consciência, sentimentos ou experiências reais.
- Use as memórias salvas somente quando forem relevantes.
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

function looksDegenerate(text) {
  if (!text) return false;
  const words = text.trim().split(/\s+/);
  if (words.length < 6) return false;

  // Muitas palavras repetidas seguidas (loop de repetição).
  let repeats = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) repeats++;
  }
  if (repeats / words.length > 0.15) return true;

  // Alta proporção de "palavras" muito curtas/soltas (números, letras isoladas, hífens),
  // típico do colapso visto no print (ex: "1, 2 3 2 1 3 2 3 2 1 2 2 1 2").
  const fragmentLike = words.filter((w) => /^[\d.,-]+$|^[A-Za-zÀ-ÿ]{1,2}$/.test(w)).length;
  if (fragmentLike / words.length > 0.4) return true;

  return false;
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

    if (
      typeof DB.getProfile !== 'function' ||
      typeof DB.getFacts !== 'function' ||
      typeof DB.saveFact !== 'function'
    ) {
      throw new Error(
        'O navegador carregou uma versão antiga de database.js. Atualize a página ou limpe os dados deste site.'
      );
    }
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
    }, {
      // Limita explicitamente a janela de contexto para evitar que o modelo
      // "estoure" o contexto e comece a alucinar/repetir quando a conversa cresce.
      context_window_size: 2048,
      sliding_window_size: -1,
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
    // Um modelo de 1B degrada rápido com muito histórico; 6 mensagens (3 trocas)
    // é mais seguro que 12 para manter a coerência.
    const context = await DB.getRecentMessages(6);
    const systemPrompt = await buildSystemPrompt();
    await DB.saveMessage('user', text);

    const chunks = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        ...context,
        { role: 'user', content: text },
      ],
      stream: true,
      temperature: 0.30,
      top_p: 0.9,
      max_tokens: 250,
      repetition_penalty: 1.3,
      frequency_penalty: 0.4,
    });

    for await (const chunk of chunks) {
      const piece = chunk.choices?.[0]?.delta?.content || '';
      assistantText += piece;
      assistantMessage.textContent = assistantText;
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }

    let finalText = assistantText.trim() || 'Não consegui formar uma resposta. Tente reformular a mensagem.';

    if (looksDegenerate(finalText)) {
      // Não salva a resposta quebrada no histórico — se salvasse, ela viraria
      // contexto para a próxima mensagem e o problema só pioraria.
      finalText = 'Me perdi um pouco agora e a resposta saiu confusa. Pode repetir ou reformular a mensagem?';
      assistantMessage.textContent = finalText;
    } else {
      assistantMessage.textContent = finalText;
      await DB.saveMessage('assistant', finalText);
    }
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
