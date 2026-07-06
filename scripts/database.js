const DB_NAME = 'ParceiraVirtualDB';
const DB_VERSION = 1;

export const DB = {
  db: null,

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('chat_history')) {
          const chatStore = db.createObjectStore('chat_history', {
            keyPath: 'id',
            autoIncrement: true,
          });
          chatStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        if (!db.objectStoreNames.contains('memories')) {
          db.createObjectStore('memories', { keyPath: 'key' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;
        try {
          await this.initDefaultMemory();
          resolve(true);
        } catch (error) {
          reject(error);
        }
      };

      request.onerror = () => reject(request.error || new Error('Erro ao abrir o IndexedDB.'));
    });
  },

  async initDefaultMemory() {
    const memoryExists = await this.getMemory('perfil_usuario');
    if (memoryExists) return;

    await this.saveMemory({
      key: 'perfil_usuario',
      nome_usuario: 'Augusto',
      estilo_conversa: 'informal, direto e bem-humorado',
      preferencias: ['tecnologia', 'música offline', 'venda de trufas de chocolate'],
      resumo_conversa_anterior: 'O usuário configurou esta IA no Samsung para ter conversas privadas.',
    });
  },

  async saveMessage(role, content) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chat_history'], 'readwrite');
      const store = transaction.objectStore('chat_history');
      const request = store.add({ role, content, timestamp: Date.now() });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error || new Error('Erro ao salvar mensagem.'));
    });
  },

  async getRecentMessages(limit = 10) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chat_history'], 'readonly');
      const store = transaction.objectStore('chat_history');
      const request = store.getAll();

      request.onsuccess = () => {
        const recent = request.result.slice(-limit).map(({ role, content }) => ({ role, content }));
        resolve(recent);
      };
      request.onerror = () => reject(request.error || new Error('Erro ao ler o histórico.'));
    });
  },

  async saveMemory(data) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['memories'], 'readwrite');
      transaction.objectStore('memories').put(data);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('Erro ao salvar memória.'));
    });
  },

  async getMemory(key) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['memories'], 'readonly');
      const request = transaction.objectStore('memories').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Erro ao ler memória.'));
    });
  },
};
