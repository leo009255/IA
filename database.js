const DB_NAME = 'IALocalPrivadaDB';
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
          await this.initDefaultProfile();
          resolve(true);
        } catch (error) {
          reject(error);
        }
      };

      request.onerror = () => reject(request.error || new Error('Erro ao abrir o IndexedDB.'));
    });
  },

  async initDefaultProfile() {
    const existing = await this.getMemory('profile');
    if (existing) return;

    await this.saveMemory({
      key: 'profile',
      preferred_name: '',
      conversation_style: 'informal, direto, natural e bem-humorado',
      created_at: Date.now(),
    });
  },

  async saveMessage(role, content) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chat_history'], 'readwrite');
      const request = transaction.objectStore('chat_history').add({
        role,
        content,
        timestamp: Date.now(),
      });

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error || new Error('Erro ao salvar mensagem.'));
    });
  },

  async getRecentMessages(limit = 12) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chat_history'], 'readonly');
      const request = transaction.objectStore('chat_history').getAll();

      request.onsuccess = () => {
        const recent = request.result
          .slice(-limit)
          .map(({ role, content }) => ({ role, content }));
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

  async getProfile() {
    return this.getMemory('profile');
  },

  async saveFact(content) {
    const normalized = content.trim();
    if (!normalized) return false;

    return this.saveMemory({
      key: `fact_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'fact',
      content: normalized,
      created_at: Date.now(),
    });
  },

  async getFacts(limit = 12) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['memories'], 'readonly');
      const request = transaction.objectStore('memories').getAll();

      request.onsuccess = () => {
        const facts = request.result
          .filter((item) => item.type === 'fact' && typeof item.content === 'string')
          .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
          .slice(-limit);
        resolve(facts);
      };
      request.onerror = () => reject(request.error || new Error('Erro ao listar memórias.'));
    });
  },

  async clearFacts() {
    const facts = await this.getFacts(Number.MAX_SAFE_INTEGER);
    if (!facts.length) return true;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['memories'], 'readwrite');
      const store = transaction.objectStore('memories');
      for (const fact of facts) store.delete(fact.key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('Erro ao apagar memórias.'));
    });
  },
};
