import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.1.3/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/+esm';

const SUPABASE_URL = 'https://iazsajsohlwrkijasrvx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NEUmXrKjpChsMwa810ojcQ_OpSiaoMm';
const EMAIL = 'henri@devin-chat.local';
const DEFAULT_MODEL = 'swe-2-high';
const POLL_MS = 1500;
const STATUS_MS = 15_000;
const OFFLINE_AFTER_MS = 45_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const els = {
  loginView: $('login-view'), loginForm: $('login-form'), loginPassword: $('login-password'),
  loginError: $('login-error'), app: $('app'), sidebar: $('sidebar'), overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'), newChatBtn: $('new-chat'), chatList: $('chat-list'), logout: $('logout'),
  chatTitle: $('chat-title'), modelSelect: $('model-select'), banner: $('offline-banner'),
  messages: $('messages'), composer: $('composer'), input: $('composer-input'), sendBtn: $('send-btn'),
};

const state = {
  chats: [],
  current: null,        // chat row or null = unsaved new chat
  messages: [],
  models: [],
  pollTimer: null,
  sending: false,
};

marked.setOptions({ breaks: true });

// ---------- helpers ----------

function shortInfo(info) {
  if (!info) return '';
  if (/free/i.test(info)) return 'Free';
  const parts = info.split(',');
  return parts[parts.length - 1].trim();
}

function modelLabel(id) {
  const m = state.models.find((x) => x.id === id);
  return m ? m.label : id || '';
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function hasActive(chatMessages) {
  return chatMessages.some((m) => m.status === 'pending' || m.status === 'running');
}

function setComposerEnabled() {
  const blocked = state.sending || hasActive(state.messages) || !navigator.onLine;
  els.sendBtn.disabled = blocked;
  els.input.disabled = false;
}

// ---------- auth ----------

async function init() {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    showApp();
  } else {
    els.loginView.hidden = false;
  }
  supabase.auth.onAuthStateChange((_e, session) => {
    if (session) showApp();
    else {
      els.app.hidden = true;
      els.loginView.hidden = false;
      stopPolling();
    }
  });
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.hidden = true;
  const { error } = await supabase.auth.signInWithPassword({
    email: EMAIL,
    password: els.loginPassword.value,
  });
  if (error) {
    els.loginError.textContent =
      error.message.toLowerCase().includes('invalid') ? 'Falsches Passwort.' : error.message;
    els.loginError.hidden = false;
  }
});

els.logout.addEventListener('click', () => supabase.auth.signOut());

// ---------- data ----------

async function showApp() {
  els.loginView.hidden = true;
  els.app.hidden = false;
  await Promise.all([loadChats(), loadModels()]);
  if (!state.current) newChat(false);
  tickWorkerStatus();
  setInterval(tickWorkerStatus, STATUS_MS);
}

async function loadChats() {
  const { data, error } = await supabase
    .from('chats')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return console.error(error);
  state.chats = data || [];
  renderChatList();
}

async function loadModels() {
  const { data, error } = await supabase.from('models').select('*').order('sort');
  if (error) return console.error(error);
  state.models = data || [];
  renderModelSelect();
}

function renderModelSelect() {
  const sel = els.modelSelect;
  const prev = sel.value;
  sel.textContent = '';
  const families = new Map();
  for (const m of state.models) {
    if (!families.has(m.family)) families.set(m.family, []);
    families.get(m.family).push(m);
  }
  for (const [family, items] of families) {
    const g = document.createElement('optgroup');
    g.label = family;
    for (const m of items) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label + (shortInfo(m.info) ? ` — ${shortInfo(m.info)}` : '');
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  sel.value = prev || selectedModel();
  if (!sel.value) sel.value = DEFAULT_MODEL;
}

function selectedModel() {
  if (state.current) return state.current.model || DEFAULT_MODEL;
  return localStorage.getItem('lastModel') || DEFAULT_MODEL;
}

els.modelSelect.addEventListener('change', async () => {
  const id = els.modelSelect.value;
  localStorage.setItem('lastModel', id);
  if (state.current) {
    state.current.model = id;
    await supabase.from('chats').update({ model: id }).eq('id', state.current.id);
  }
});

// ---------- chats ----------

function renderChatList() {
  els.chatList.textContent = '';
  for (const c of state.chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (state.current?.id === c.id ? ' active' : '');
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'chat-item-title';
    title.textContent = c.title || 'Neuer Chat';
    title.addEventListener('click', () => openChat(c));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'chat-item-btn';
    edit.title = 'Umbenennen';
    edit.textContent = '✎';
    edit.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = prompt('Neuer Titel:', c.title);
      if (t && t.trim()) {
        await supabase.from('chats').update({ title: t.trim() }).eq('id', c.id);
        c.title = t.trim();
        if (state.current?.id === c.id) els.chatTitle.textContent = c.title;
        renderChatList();
      }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-item-btn';
    del.title = 'Löschen';
    del.textContent = '🗑';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Chat „${c.title}“ löschen?`)) return;
      await supabase.from('chats').delete().eq('id', c.id);
      state.chats = state.chats.filter((x) => x.id !== c.id);
      if (state.current?.id === c.id) newChat();
      renderChatList();
    });
    item.append(title, edit, del);
    els.chatList.appendChild(item);
  }
}

function newChat(rerender = true) {
  state.current = null;
  state.messages = [];
  stopPolling();
  els.chatTitle.textContent = 'Neuer Chat';
  els.modelSelect.value = localStorage.getItem('lastModel') || DEFAULT_MODEL;
  renderMessages();
  if (rerender) renderChatList();
  closeSidebar();
  setComposerEnabled();
}

async function openChat(chat) {
  state.current = chat;
  els.chatTitle.textContent = chat.title || 'Neuer Chat';
  els.modelSelect.value = chat.model || DEFAULT_MODEL;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', chat.id)
    .order('created_at');
  if (error) return console.error(error);
  state.messages = data || [];
  renderMessages();
  renderChatList();
  closeSidebar();
  if (hasActive(state.messages)) startPolling();
  setComposerEnabled();
}

async function refreshMessages() {
  if (!state.current) return;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', state.current.id)
    .order('created_at');
  if (error) return console.error(error);
  state.messages = data || [];
  renderMessages();
  if (!hasActive(state.messages)) {
    stopPolling();
    loadChats();
  }
  setComposerEnabled();
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(refreshMessages, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// ---------- send ----------

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

els.input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (matchMedia('(pointer: coarse)').matches) return; // Enter = newline on touch
  e.preventDefault();
  send();
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
});

async function send() {
  const text = els.input.value.trim();
  if (!text || state.sending || hasActive(state.messages)) return;
  state.sending = true;
  setComposerEnabled();
  const model = els.modelSelect.value || DEFAULT_MODEL;
  localStorage.setItem('lastModel', model);
  try {
    const isFirst = state.messages.length === 0;
    if (!state.current) {
      const { data: chat, error } = await supabase
        .from('chats')
        .insert({ title: text.slice(0, 50), model })
        .select()
        .single();
      if (error) throw error;
      state.current = chat;
      els.chatTitle.textContent = chat.title;
    } else {
      const upd = { model, updated_at: new Date().toISOString() };
      if (isFirst) {
        upd.title = text.slice(0, 50);
        state.current.title = upd.title;
        els.chatTitle.textContent = upd.title;
      }
      await supabase.from('chats').update(upd).eq('id', state.current.id);
    }
    state.current.model = model;
    const { error: e1 } = await supabase
      .from('messages')
      .insert({ chat_id: state.current.id, role: 'user', content: text, status: 'done' });
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from('messages')
      .insert({ chat_id: state.current.id, role: 'assistant', content: '', status: 'pending', model });
    if (e2) throw e2;
    els.input.value = '';
    els.input.style.height = 'auto';
    await refreshMessages();
    startPolling();
    loadChats();
  } catch (err) {
    console.error(err);
    alert('Senden fehlgeschlagen: ' + err.message);
  } finally {
    state.sending = false;
    setComposerEnabled();
  }
}

async function retryMessage(id) {
  await supabase
    .from('messages')
    .update({ status: 'pending', error: null, content: '', updated_at: new Date().toISOString() })
    .eq('id', id);
  await refreshMessages();
  startPolling();
}

// ---------- render ----------

function renderMessages() {
  els.messages.textContent = '';
  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<h2>Hallo Henri!</h2><p>Womit kann ich helfen?</p>';
    els.messages.appendChild(empty);
  }
  for (const m of state.messages) {
    els.messages.appendChild(renderMessage(m));
  }
  scrollBottom();
}

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = `msg msg-${m.role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'user') {
    bubble.classList.add('bubble-user');
    bubble.textContent = m.content;
  } else {
    bubble.classList.add('bubble-assistant');
    if (m.status === 'pending' || m.status === 'running') {
      bubble.innerHTML = '<span class="thinking">denkt nach<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>';
    } else if (m.status === 'error') {
      const err = document.createElement('div');
      err.className = 'error-box';
      const p = document.createElement('p');
      p.textContent = `Fehler: ${m.error || 'unbekannt'}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'retry-btn';
      btn.textContent = 'Erneut versuchen';
      btn.addEventListener('click', () => retryMessage(m.id));
      err.append(p, btn);
      bubble.appendChild(err);
      if (m.content) {
        const c = document.createElement('div');
        c.innerHTML = renderMarkdown(m.content);
        bubble.appendChild(c);
      }
    } else {
      bubble.innerHTML = renderMarkdown(m.content);
      addCopyButtons(bubble);
    }
    if (m.model) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = modelLabel(m.model);
      div.append(bubble, meta);
      return div;
    }
  }
  div.appendChild(bubble);
  return div;
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('code-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const bar = document.createElement('div');
    bar.className = 'code-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Kopieren';
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.textContent);
      btn.textContent = 'Kopiert!';
      setTimeout(() => (btn.textContent = 'Kopieren'), 1500);
    });
    bar.appendChild(btn);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.append(bar, pre);
  }
}

// ---------- worker status ----------

async function tickWorkerStatus() {
  const { data, error } = await supabase.from('worker_status').select('last_seen').limit(1);
  const stale =
    error || !data?.length || Date.now() - new Date(data[0].last_seen).getTime() > OFFLINE_AFTER_MS;
  els.banner.hidden = !stale;
}

// ---------- sidebar drawer ----------

function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.overlay.classList.remove('show');
}
els.menuBtn.addEventListener('click', () => {
  els.sidebar.classList.add('open');
  els.overlay.classList.add('show');
});
els.overlay.addEventListener('click', closeSidebar);
els.newChatBtn.addEventListener('click', () => newChat());

init();
