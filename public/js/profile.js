// db.js — IndexedDB wrapper for SAGE persistence
const DB = (() => {
  const DB_NAME = 'SAGE_DB';
  const DB_VERSION = 4;
  let db = null;

  const STORES = {
    profiles: 'profiles',
    agents: 'agents',
    sessions: 'sessions',
    picks: 'picks',
    performance: 'performance',
    regimes: 'regimes',
    backtests: 'backtests',
    settings: 'settings',
  };

  const SCOPED_STORES = new Set([STORES.agents, STORES.sessions, STORES.picks, STORES.performance, STORES.regimes, STORES.backtests, STORES.settings]);

  function getCurrentOwner() {
    try { return (Auth?.getSession?.()?.username || localStorage.getItem('sage_last_user') || 'global').toLowerCase(); }
    catch { return 'global'; }
  }

  function scopeKey(key) { return `${getCurrentOwner()}::${key}`; }
  function isScopedStore(store) { return SCOPED_STORES.has(store); }
  function scopeRecord(store, record) { return record && typeof record === 'object' && isScopedStore(store) && !record.owner ? { ...record, owner: getCurrentOwner() } : record; }
  function matchesOwner(record, owner = getCurrentOwner()) { return !record?.owner || record.owner === owner; }

  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORES.profiles)) d.createObjectStore(STORES.profiles, { keyPath: 'username' });
        if (!d.objectStoreNames.contains(STORES.agents)) d.createObjectStore(STORES.agents, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORES.sessions)) d.createObjectStore(STORES.sessions, { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains(STORES.picks)) { const ps = d.createObjectStore(STORES.picks, { keyPath: 'id', autoIncrement: true }); ps.createIndex('agentId', 'agentId'); ps.createIndex('domain', 'domain'); ps.createIndex('sessionId', 'sessionId'); }
        if (!d.objectStoreNames.contains(STORES.performance)) d.createObjectStore(STORES.performance, { keyPath: 'agentId' });
        if (!d.objectStoreNames.contains(STORES.regimes)) d.createObjectStore(STORES.regimes, { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains(STORES.backtests)) d.createObjectStore(STORES.backtests, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORES.settings)) d.createObjectStore(STORES.settings, { keyPath: 'key' });
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

  async function getScopedAll(store) {
    const all = await tx(store, 'readonly', s => s.getAll());
    const owner = getCurrentOwner();
    const owned = all.filter(r => r?.owner === owner);
    return owned.length ? owned : all.filter(r => !r?.owner);
  }

  async function getScopedByKey(store, key) {
    const rec = await tx(store, 'readonly', s => s.get(key));
    return rec && matchesOwner(rec) ? rec : (rec && !rec.owner ? rec : null);
  }

  async function clearScopedStore(store, owner = getCurrentOwner()) {
    const all = await tx(store, 'readonly', s => s.getAll());
    const keys = all.filter(r => (r?.owner || 'global') === owner).map(r => {
      if (store === STORES.performance) return r.agentId;
      if (store === STORES.settings) return r.key;
      return r.id;
    });
    for (const key of keys) await tx(store, 'readwrite', s => s.delete(key));
  }

  return {
    async put(store, record) { return tx(store, 'readwrite', s => s.put(scopeRecord(store, record))); },
    async get(store, key) {
      if (store === STORES.settings) {
        const scoped = await tx(store, 'readonly', s => s.get(scopeKey(key)));
        if (scoped) return scoped;
        return tx(store, 'readonly', s => s.get(key));
      }
      return tx(store, 'readonly', s => s.get(key));
    },
    async getAll(store) { return tx(store, 'readonly', s => s.getAll()); },
    async delete(store, key) { return tx(store, 'readwrite', s => s.delete(key)); },
    async clear(store) { return tx(store, 'readwrite', s => s.clear()); },

    async getSetting(key, defaultVal = null) {
      const rec = await this.get(STORES.settings, key);
      return rec ? rec.value : defaultVal;
    },
    async setSetting(key, value) { return this.put(STORES.settings, { key: scopeKey(key), value }); },

    async saveAgent(agent) { return this.put(STORES.agents, agent); },
    async getAllAgents() { return getScopedAll(STORES.agents); },
    async getAgent(id) { return getScopedByKey(STORES.agents, id); },

    async saveSession(session) { return this.put(STORES.sessions, session); },
    async getAllSessions() { return getScopedAll(STORES.sessions); },

    async savePick(pick) { return this.put(STORES.picks, pick); },
    async getAllPicks() { return getScopedAll(STORES.picks); },
    async getPicksByAgent(agentId) { return (await this.getAllPicks()).filter(p => p.agentId === agentId); },
    async getPicksByDomain(domain) { return (await this.getAllPicks()).filter(p => p.domain === domain); },

    async savePerf(perf) { return this.put(STORES.performance, perf); },
    async getPerf(agentId) { return getScopedByKey(STORES.performance, agentId); },
    async getAllPerf() { return getScopedAll(STORES.performance); },

    async getAllRegimes() { return getScopedAll(STORES.regimes); },
    async getAllBacktests() { return getScopedAll(STORES.backtests); },

    async exportScopedData(owner = getCurrentOwner()) {
      const bundle = {};
      for (const store of [STORES.agents, STORES.sessions, STORES.picks, STORES.performance, STORES.regimes, STORES.backtests, STORES.settings]) {
        const rows = await tx(store, 'readonly', s => s.getAll());
        bundle[store] = rows.filter(r => (r?.owner || 'global') === owner || (!r?.owner && owner === 'global'));
      }
      return bundle;
    },
    async importScopedData(owner, bundle = {}, { replace = true } = {}) {
      if (!owner) throw new Error('Missing owner for import');
      if (replace) {
        for (const store of [STORES.agents, STORES.sessions, STORES.picks, STORES.performance, STORES.regimes, STORES.backtests, STORES.settings]) {
          await clearScopedStore(store, owner);
        }
      }
      const writeStore = async (store, rows) => {
        for (const row of rows || []) {
          const rec = { ...row, owner };
          if (store === STORES.settings && !String(rec.key || '').includes('::')) rec.key = `${owner}::${rec.key}`;
          await this.put(store, rec);
        }
      };
      await writeStore(STORES.agents, bundle[STORES.agents]);
      await writeStore(STORES.sessions, bundle[STORES.sessions]);
      await writeStore(STORES.picks, bundle[STORES.picks]);
      await writeStore(STORES.performance, bundle[STORES.performance]);
      await writeStore(STORES.regimes, bundle[STORES.regimes]);
      await writeStore(STORES.backtests, bundle[STORES.backtests]);
      await writeStore(STORES.settings, bundle[STORES.settings]);
    },

    STORES,
    getCurrentOwner,
  };
})();
