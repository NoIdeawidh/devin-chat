// Zugriffsschicht auf rpc/events/bridge_status. Zwei Implementierungen:
// SupaStore (echtes Supabase, signIn + Auth-Retry) und MemoryStore (Tests/Mock,
// gleiche API, alles im Speicher).

const RPC_PENDING_LIMIT = 10;
const EVENTS_KEEP_MS = 2 * 24 * 3600 * 1000;
const RPC_KEEP_MS = 24 * 3600 * 1000;

function isAuthError(err) {
  const s = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return s.includes('jwt') || s.includes('401') || s.includes('pgrst301') || s.includes('auth');
}

export class SupaStore {
  constructor(supabase, { email, password, ownerId, log = () => {} }) {
    this.sb = supabase;
    this.email = email;
    this.password = password;
    this.ownerId = ownerId;
    this.log = log;
  }

  async signIn() {
    const { error } = await this.sb.auth.signInWithPassword({ email: this.email, password: this.password });
    if (error) throw new Error(`Bridge-Login fehlgeschlagen: ${error.message}`);
    this.log('Bridge angemeldet.');
  }

  // Fuehrt fn() aus; bei Auth-Fehler einmal neu einloggen und wiederholen.
  async _run(fn) {
    const r = await fn();
    if (!r.error) return r;
    if (isAuthError(r.error)) {
      this.log('Auth-Fehler – melde neu an und wiederhole.');
      await this.signIn();
      const r2 = await fn();
      if (r2.error) throw r2.error;
      return r2;
    }
    throw r.error;
  }

  async pollPendingRpc(limit = RPC_PENDING_LIMIT) {
    const r = await this._run(() =>
      this.sb
        .from('rpc')
        .select('id,method,params,created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(limit)
    );
    return r.data || [];
  }

  async claimRpc(id) {
    const r = await this._run(() =>
      this.sb.from('rpc').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending').select('id')
    );
    return (r.data || []).length === 1;
  }

  async finishRpc(id, { result, error }) {
    const fields = { updated_at: new Date().toISOString() };
    if (error) {
      fields.status = 'error';
      fields.error = error;
    } else {
      fields.status = 'done';
      fields.result = result ?? {};
    }
    await this._run(() => this.sb.from('rpc').update(fields).eq('id', id));
  }

  async insertEvents(rows) {
    if (!rows.length) return;
    await this._run(() =>
      this.sb.from('events').insert(rows.map((r) => ({ ...r, owner: this.ownerId })))
    );
  }

  async upsertStatus(fields) {
    await this._run(() =>
      this.sb.from('bridge_status').upsert({ owner: this.ownerId, last_seen: new Date().toISOString(), ...fields })
    );
  }

  async cleanup(now = Date.now()) {
    const evBefore = new Date(now - EVENTS_KEEP_MS).toISOString();
    const rpcBefore = new Date(now - RPC_KEEP_MS).toISOString();
    await this._run(() => this.sb.from('events').delete().lt('created_at', evBefore));
    await this._run(() =>
      this.sb.from('rpc').delete().in('status', ['done', 'error']).lt('updated_at', rpcBefore)
    );
  }
}

export class MemoryStore {
  constructor({ ownerId = 'owner-test' } = {}) {
    this.ownerId = ownerId;
    this.rpc = [];
    this.events = [];
    this.status = null;
    this.nextEventId = 1;
    this.cleaned = [];
  }

  async signIn() {}
  _id() {
    return crypto.randomUUID();
  }

  // Test-Helfer: Frontend-Insert simulieren
  addRpc(method, params = {}) {
    const row = { id: this._id(), owner: this.ownerId, method, params, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.rpc.push(row);
    return row;
  }

  async pollPendingRpc(limit = RPC_PENDING_LIMIT) {
    return this.rpc
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((r) => ({ id: r.id, method: r.method, params: r.params, created_at: r.created_at }));
  }

  async claimRpc(id) {
    const row = this.rpc.find((r) => r.id === id && r.status === 'pending');
    if (!row) return false;
    row.status = 'running';
    row.updated_at = new Date().toISOString();
    return true;
  }

  async finishRpc(id, { result, error }) {
    const row = this.rpc.find((r) => r.id === id);
    if (!row) return;
    row.updated_at = new Date().toISOString();
    if (error) {
      row.status = 'error';
      row.error = error;
    } else {
      row.status = 'done';
      row.result = result ?? {};
    }
  }

  async insertEvents(rows) {
    for (const r of rows) {
      this.events.push({ id: this.nextEventId++, owner: this.ownerId, ...r, created_at: new Date().toISOString() });
    }
  }

  async upsertStatus(fields) {
    this.status = { owner: this.ownerId, last_seen: new Date().toISOString(), ...fields };
  }

  async cleanup(now = Date.now()) {
    const evBefore = new Date(now - EVENTS_KEEP_MS).toISOString();
    const rpcBefore = new Date(now - RPC_KEEP_MS).toISOString();
    const evDel = this.events.filter((e) => e.created_at < evBefore).map((e) => e.id);
    this.events = this.events.filter((e) => e.created_at >= evBefore);
    const rpcDel = this.rpc.filter((r) => ['done', 'error'].includes(r.status) && r.updated_at < rpcBefore).map((r) => r.id);
    this.rpc = this.rpc.filter((r) => !rpcDel.includes(r.id));
    this.cleaned.push({ events: evDel.length, rpc: rpcDel.length });
    return { events: evDel.length, rpc: rpcDel.length };
  }
}
