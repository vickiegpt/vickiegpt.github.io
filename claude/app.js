const initialFiles = {
  'README.md': '# Browser workspace\n\nAsk Claude to inspect or improve this file.\n',
  'app.js': "export function hello(name) {\n  return `Hello, ${name}`;\n}\n",
};

const storedFiles = localStorage.getItem('vickie-claude-files');
const state = {
  files: storedFiles ? JSON.parse(storedFiles) : initialFiles,
  active: 'README.md',
  messages: [],
  busy: false,
};

const $ = (selector) => document.querySelector(selector);
const editor = $('#editor');
const fileList = $('#file-list');
const messages = $('#messages');
const prompt = $('#prompt');
const dialog = $('#settings-dialog');

function saveFiles() {
  localStorage.setItem('vickie-claude-files', JSON.stringify(state.files));
}

function renderFiles() {
  fileList.replaceChildren(...Object.keys(state.files).map((name) => {
    const button = document.createElement('button');
    button.className = `file${name === state.active ? ' active' : ''}`;
    button.textContent = name;
    button.type = 'button';
    button.onclick = () => openFile(name);
    return button;
  }));
  $('#context-label').textContent = `${Object.keys(state.files).length} files available`;
}

function openFile(name) {
  state.active = name;
  editor.value = state.files[name];
  $('#active-file-name').textContent = name;
  $('#dirty-indicator').classList.remove('dirty');
  renderFiles();
  updateCursor();
}

function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const lines = before.split('\n');
  $('#cursor-position').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
}

function addMessage(role, text) {
  const node = $('#message-template').content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.message-meta').textContent = role === 'user' ? 'You' : role === 'error' ? 'Connection error' : 'Claude';
  node.querySelector('.message-body').textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  state.messages.push({ role: role === 'error' ? 'assistant' : role, content: text });
}

function settings() {
  return {
    endpoint: sessionStorage.getItem('vickie-claude-endpoint') || '',
    key: sessionStorage.getItem('vickie-claude-key') || '',
    model: sessionStorage.getItem('vickie-claude-model') || 'glm-4.7',
  };
}

function showSettings() {
  const current = settings();
  $('#endpoint').value = current.endpoint;
  $('#api-key').value = current.key;
  $('#model').value = current.model;
  dialog.showModal();
}

async function requestClaude(userText) {
  const config = settings();
  if (!config.endpoint) {
    showSettings();
    throw new Error('Set a Claude-compatible relay endpoint first.');
  }

  const context = Object.entries(state.files)
    .map(([name, content]) => `<file path="${name}">\n${content}\n</file>`)
    .join('\n\n');
  const history = state.messages.slice(-12).map(({ role, content }, index, recent) => ({
    role,
    content: index === recent.length - 1 && role === 'user'
      ? `${content}\n\nBrowser workspace:\n${context}`
      : content,
  }));

  const endpoint = normalizeEndpoint(config.endpoint);
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (config.key) headers.authorization = `Bearer ${config.key}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: 'You are Claude Code in a browser sandbox. Give precise coding help. You may propose file replacements, but never claim to have executed shell commands.',
      messages: history,
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return extractEventStreamText(await response.text());
  }
  return extractResponseText(await response.json());
}

function normalizeEndpoint(value) {
  const endpoint = value.trim().replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(endpoint) || /\/messages$/i.test(endpoint)) return endpoint;
  return `${endpoint}/v1/messages`;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return contentText(value.text ?? value.content ?? value.output_text ?? '');
}

function extractResponseText(data) {
  const text = contentText(data?.content)
    || contentText(data?.message?.content)
    || contentText(data?.choices?.[0]?.message?.content)
    || contentText(data?.output)
    || contentText(data?.reply)
    || contentText(data?.result);
  if (text) return text;
  const shape = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
  throw new Error(`The relay returned no text (response fields: ${shape || 'none'}).`);
}

function extractEventStreamText(body) {
  const chunks = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      const text = contentText(event?.delta?.text)
        || contentText(event?.content_block?.text)
        || contentText(event?.content)
        || contentText(event?.choices?.[0]?.delta?.content);
      if (text) chunks.push(text);
    } catch {
      // Ignore heartbeat and non-JSON SSE lines.
    }
  }
  if (chunks.length) return chunks.join('');
  throw new Error('The relay stream completed without text.');
}

editor.addEventListener('input', () => {
  state.files[state.active] = editor.value;
  $('#dirty-indicator').classList.add('dirty');
  saveFiles();
  updateCursor();
});
editor.addEventListener('click', updateCursor);
editor.addEventListener('keyup', updateCursor);

$('#new-file').onclick = () => {
  const rawName = window.prompt('New file name');
  const name = rawName?.trim().replace(/^\/+/, '');
  if (!name || state.files[name] !== undefined) return;
  state.files[name] = '';
  saveFiles();
  openFile(name);
};

$('#settings-button').onclick = showSettings;
$('#settings-form').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  sessionStorage.setItem('vickie-claude-endpoint', $('#endpoint').value.trim());
  sessionStorage.setItem('vickie-claude-key', $('#api-key').value);
  sessionStorage.setItem('vickie-claude-model', $('#model').value.trim());
  $('#status-text').textContent = $('#endpoint').value ? 'relay configured' : 'local workspace';
  dialog.close();
});

$('#clear-chat').onclick = () => {
  state.messages = [];
  messages.replaceChildren();
  addMessage('assistant', 'Session cleared. What should we build next?');
};

$('#prompt-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const text = prompt.value.trim();
  if (!text) return;
  addMessage('user', text);
  prompt.value = '';
  state.busy = true;
  $('#send').disabled = true;
  $('#status-text').textContent = 'Claude is working';
  try {
    addMessage('assistant', await requestClaude(text));
    $('#status-text').textContent = 'relay connected';
  } catch (error) {
    addMessage('error', error.message);
    $('#status-text').textContent = 'connection needed';
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    prompt.focus();
  }
});

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $('#prompt-form').requestSubmit();
  }
});

openFile(state.active);
addMessage('assistant', 'Browser workspace ready. Open Connection to attach an Anthropic-compatible relay, then ask me about the files on the left.');
