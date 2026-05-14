// db.js — IndexedDB wrapper for SAGE persistence
const DB = (() => {
  const DB_NAME = 'SAGE_DB';
  const DB_VERSION = 3;
  let db = null;

  const STORES = {
    profiles: 'profiles',       // encrypted user profiles (username → encrypted key blob)
    agents: 'agents',           // agent definitions + weights + prompt history
    sessions: 'sessions',       // debate session logs
    picks: 'picks',             // all trading & sports picks
    performance: 'performance', // per-agent rolling performance
    regimes: 'regimes',         // regime history
    backtests: 'backtests',     // saved backtest results
    settings: 'settings',       // app settings
  };

  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORES.profiles))
          d.createObjectStore(STORES.profiles, { keyPath: 'username' });
        if (!d.objectStoreNames.contains(STORES.agents))
          d.createObjectStore(STORES.agents, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORES.sessions))
          d.createObjectStore(STORES.sessions, { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains(STORES.picks)) {
          const ps = d.createObjectStore(STORES.picks, { keyPath: 'id', autoIncrement: true });
          ps.createIndex('agentId', 'agentId');
          ps.createIndex('domain', 'domain');
          ps.createIndex('sessionId', 'sessionId');
        }
        if (!d.objectStoreNames.contains(STORES.performance))
          d.createObjectStore(STORES.performance, { keyPath: 'agentId' });
        if (!d.objectStoreNames.contains(STORES.regimes))
          d.createObjectStore(STORES.regimes, { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains(STORES.backtests))
          d.createObjectStore(STORES.backtests, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORES.settings))
          d.createObjectStore(STORES.settings, { keyPath: 'key' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      if (req && req.onsuccess !== undefined) {
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
      } else {
        t.oncomplete = () => resolve(req);
        t.onerror = e => reject(e.target.error);
      }
    });
  }

  return {
    // ── Generic CRUD ──
    async put(store, record) {
      return tx(store, 'readwrite', s => s.put(record));
    },
    async get(store, key) {
      return tx(store, 'readonly', s => s.get(key));
    },
    async getAll(store) {
      return tx(store, 'readonly', s => s.getAll());
    },
    async delete(store, key) {
      return tx(store, 'readwrite', s => s.delete(key));
    },
    async clear(store) {
      return tx(store, 'readwrite', s => s.clear());
    },

    // ── Settings helpers ──
    async getSetting(key, defaultVal = null) {
      const rec = await this.get(STORES.settings, key);
      return rec ? rec.value : defaultVal;
    },
    async setSetting(key, value) {
      return this.put(STORES.settings, { key, value });
    },

    // ── Agent helpers ──
    async saveAgent(agent) {
      return this.put(STORES.agents, agent);
    },
    async getAllAgents() {
      return this.getAll(STORES.agents);
    },
    async getAgent(id) {
      return this.get(STORES.agents, id);
    },

    // ── Session helpers ──
    async saveSession(session) {
      return this.put(STORES.sessions, session);
    },
    async getAllSessions() {
      return this.getAll(STORES.sessions);
    },

    // ── Pick helpers ──
    async savePick(pick) {
      return this.put(STORES.picks, pick);
    },
    async getAllPicks() {
      return this.getAll(STORES.picks);
    },
    async getPicksByAgent(agentId) {
      const all = await this.getAllPicks();
      return all.filter(p => p.agentId === agentId);
    },
    async getPicksByDomain(domain) {
      const all = await this.getAllPicks();
      return all.filter(p => p.domain === domain);
    },

    // ── Performance helpers ──
    async savePerf(perf) {
      return this.put(STORES.performance, perf);
    },
    async getPerf(agentId) {
      return this.get(STORES.performance, agentId);
    },
    async getAllPerf() {
      return this.getAll(STORES.performance);
    },

    STORES,
  };
})();
