const DB_NAME = 'atlas-client-v1';
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function completed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || Error('Local storage transaction aborted'));
    tx.onerror = () => {};
  });
}
export class ClientStore {
  static async open(name = DB_NAME) {
    if (!globalThis.indexedDB)
      throw Error(
        'This browser does not provide IndexedDB storage. Open Atlas in a regular browser window.',
      );
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('documents', { keyPath: ['project', 'id'] });
      db.createObjectStore('snapshots');
      db.createObjectStore('indexes');
    };
    const db = await request(r);
    db.onversionchange = () => db.close();
    return new ClientStore(db);
  }
  constructor(db) {
    this.db = db;
  }
  close() {
    this.db.close();
  }
  async read(store, key) {
    const tx = this.db.transaction(store, 'readonly');
    return request(tx.objectStore(store).get(key));
  }
  async write(store, value, key) {
    const tx = this.db.transaction(store, 'readwrite');
    const done = completed(tx);
    if (key === undefined) tx.objectStore(store).put(value);
    else tx.objectStore(store).put(value, key);
    await done;
  }
  project(id) {
    return this.read('projects', id);
  }
  async projects() {
    const tx = this.db.transaction('projects');
    return (await request(tx.objectStore('projects').getAll())).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }
  async createProject(value) {
    const project = { createdAt: Date.now(), state: 'importing', ...value };
    await this.write('projects', project);
    return project;
  }
  async updateProject(id, patch) {
    const tx = this.db.transaction('projects', 'readwrite'),
      done = completed(tx),
      store = tx.objectStore('projects');
    const value = await request(store.get(id));
    if (!value) {
      tx.abort();
      await done.catch(() => {});
      throw Error('Project no longer exists');
    }
    store.put({ ...value, ...patch, id });
    await done;
  }
  async putDocument(project, doc) {
    await this.write('documents', { project, id: doc.id, value: doc });
  }
  async putDocuments(project, docs) {
    if (!docs.length) return;
    const tx = this.db.transaction('documents', 'readwrite', { durability: 'relaxed' }),
      done = completed(tx);
    try {
      for (const doc of docs) tx.objectStore('documents').put({ project, id: doc.id, value: doc });
    } catch (error) {
      tx.abort();
      await done.catch(() => {});
      throw error;
    }
    await done;
  }
  async document(project, id) {
    return (await this.read('documents', [project, id]))?.value;
  }
  async snapshot(id) {
    const p = await this.project(id);
    if (p?.state !== 'ready')
      throw Error('This repository is not ready. Return to the library to import it.');
    const snapshot = await this.read('snapshots', id);
    if (!snapshot) throw Error('The local snapshot was removed. Import this repository again.');
    return snapshot;
  }
  index(id) {
    return this.read('indexes', id);
  }
  async publish(id, snapshot, metas, symbols, coverage = {}) {
    const tx = this.db.transaction(['projects', 'snapshots', 'indexes'], 'readwrite'),
      done = completed(tx),
      store = tx.objectStore('projects');
    const p = await request(store.get(id));
    if (!p || p.state !== 'importing') {
      tx.abort();
      await done.catch(() => {});
      throw Error(`Cannot publish ${p?.state || 'missing'} project`);
    }
    tx.objectStore('snapshots').put(snapshot, id);
    tx.objectStore('indexes').put({ metas, symbols, coverage }, id);
    store.put({
      ...p,
      state: 'ready',
      finishedAt: Date.now(),
      stats: snapshot.manifest.stats,
      coverage,
    });
    await done;
  }
  async clearDocuments(id) {
    const tx = this.db.transaction('documents', 'readwrite'),
      done = completed(tx);
    tx.objectStore('documents').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done;
  }
  async deleteProject(id) {
    const tx = this.db.transaction(['projects', 'documents', 'snapshots', 'indexes'], 'readwrite'),
      done = completed(tx);
    tx.objectStore('projects').delete(id);
    tx.objectStore('documents').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    tx.objectStore('snapshots').delete(id);
    tx.objectStore('indexes').delete(id);
    await done;
  }
}
