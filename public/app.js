const CATEGORIES = [
  'Numerical reasoning', 'Verbal reasoning', 'Logical reasoning', 'Abstract reasoning',
  'Spatial reasoning', 'Pattern recognition', 'Sequences', 'Analogies', 'Matrices',
  'Percentages', 'Ratios', 'Word problems', 'Critical thinking', 'Other',
];
const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Very Hard'];

const $ = (id) => document.getElementById(id);
async function api(path, opts) {
  const res = await fetch('/rest' + path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2600);
}
function copyVal(id) {
  navigator.clipboard.writeText($(id).value);
  toast('Copied to clipboard');
}

function fillSelect(el, items, placeholder) {
  el.innerHTML = `<option value="">${placeholder}</option>` + items.map((i) => `<option>${i}</option>`).join('');
}

async function loadConfig() {
  const c = await api('/config');
  const url = c.mcpUrl;
  $('mcpUrl').value = url;
  $('mcpAuth').value = c.authRequired ? 'Bearer <MCP_AUTH_TOKEN from your .env>' : '(no auth configured)';
  document.querySelector('[data-testid="providers-pill"]').textContent =
    `embeddings: ${c.embeddingProvider} · llm: ${c.llmProvider}`;
}

async function loadStats() {
  const s = await api('/stats');
  document.querySelector('[data-testid="stat-sources"]').textContent = s.sources;
  document.querySelector('[data-testid="stat-questions"]').textContent = s.questions;
  document.querySelector('[data-testid="stat-passages"]').textContent = s.passages;
}

async function loadSources() {
  const { sources } = await api('/sources');
  const body = $('sourcesBody');
  if (!sources.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No sources yet — upload a PDF to begin.</td></tr>';
  } else {
    body.innerHTML = sources
      .map((s) => {
        const statusCell =
          s.status === 'ready'
            ? `<span class="status ready">ready</span>`
            : s.status === 'error'
              ? `<span class="status error" title="${(s.error || '').replace(/"/g, '')}">error</span>`
              : `<span class="status ${s.status}">${s.phase || s.status} ${s.progress ? s.progress + '%' : ''}</span>`;
        const langBadge = `<span class="tag">${s.language || '—'}</span>`;
        const linked = (s.linkedVariants || []).length
          ? `<span class="tag" title="Linked variants: ${(s.linkedVariants || []).join(', ')}">↔ ${(s.linkedVariants || []).length} variant(s)</span>`
          : '';
        return `<tr data-testid="source-row-${s.name}">
        <td><strong>${s.name}</strong> ${langBadge} ${linked}${s.error ? `<div style="color:#f2707a;font-size:11px" data-testid="source-error">${s.error}</div>` : ''}</td>
        <td>${statusCell}</td>
        <td>${s.questions}${s.tests ? ` <span class="tag">${s.tests} tests</span>` : ''}</td>
        <td>${s.pages}</td>
        <td>${s.imagePages}</td>
        <td><div class="tags">${(s.categories || []).slice(0, 3).map((c) => `<span class="tag">${c}</span>`).join('') || '<span class="tag">—</span>'}</div></td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn ghost sm" data-testid="open-${s.name}" href="/rest/file/${s.id}" target="_blank" rel="noopener">Open</a>
          <a class="btn ghost sm" data-testid="download-${s.name}" href="/rest/file/${s.id}?download=1">Download</a>
          <button class="btn ghost sm" data-testid="reindex-${s.name}" onclick="reindexOne('${s.name.replace(/'/g, "\\'")}')">Re-index</button>
          <button class="btn danger sm" data-testid="delete-${s.name}" onclick="deleteSource('${s.name.replace(/'/g, "\\'")}')">Delete</button>
        </td></tr>`;
      })
      .join('');
  }
  fillSelect($('fSource'), sources.map((s) => s.name), 'Any source');
}

async function loadAll() {
  await Promise.all([loadStats(), loadSources()]);
}

async function pollIngest() {
  try {
    const j = await api('/ingest-status');
    const el = $('ingestStatus');
    if (j.running) {
      el.textContent = `Indexing: ${j.current || '…'} (${j.queue.length} queued)`;
      setTimeout(pollIngest, 1500);
    } else {
      el.textContent = j.lastError ? 'Last error: ' + j.lastError : (j.processed.length ? 'Idle · last run done' : '');
      loadAll();
    }
  } catch {}
}

async function doUpload() {
  const input = $('fileInput');
  if (!input.files.length) return toast('Choose PDF files first', true);
  const fd = new FormData();
  for (const f of input.files) fd.append('files', f);
  $('ingestStatus').textContent = 'Uploading…';
  try {
    await api('/upload', { method: 'POST', body: fd });
    input.value = '';
    toast('Uploaded — indexing started');
    pollIngest();
  } catch (e) {
    toast(e.message, true);
  }
}

async function reindexAll() {
  await api('/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  toast('Re-indexing all sources');
  pollIngest();
}
async function reindexOne(name) {
  await api('/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: name }) });
  toast('Re-indexing ' + name);
  pollIngest();
}
async function deleteSource(name) {
  if (!confirm('Delete "' + name + '" and all its indexed questions?')) return;
  await api('/sources/' + encodeURIComponent(name), { method: 'DELETE' });
  toast('Deleted ' + name);
  loadAll();
}

function renderQuestions(items, showScore) {
  const el = $('results');
  if (!items.length) {
    el.innerHTML = '<div class="qcard">No results.</div>';
    return;
  }
  el.innerHTML = items
    .map((q) => {
      const badges = [];
      if (showScore && q.score != null) badges.push(`<span class="badge score">sim ${q.score}</span>`);
      if (q.category) badges.push(`<span class="badge cat">${q.category}${q.categoryEstimated ? ' (est)' : ''}</span>`);
      if (q.difficulty) badges.push(`<span class="badge diff">${q.difficulty}${q.difficultyEstimated ? ' (est)' : ''}</span>`);
      if (q.requiresImage) badges.push('<span class="badge img">needs image</span>');
      else if (q.hasImage) badges.push('<span class="badge img">has figure</span>');
      if (q.type === 'passage') badges.push('<span class="badge">passage</span>');
      const choices = q.choices ? `<ul class="choices">${q.choices.map((c) => `<li>${c}</li>`).join('')}</ul>` : '';
      const img = (q.imageUrls || [])[0] ? `<img class="qimg" src="${q.imageUrls[0]}" alt="figure" />` : '';
      const ans = q.correctAnswer
        ? `<div class="answer">Answer: <strong>${q.correctAnswer}</strong>${q.explanation ? ' — ' + q.explanation : ''}</div>`
        : '';
      return `<div class="qcard" data-testid="result-card">
        <div class="qmeta">${badges.join('')}</div>
        <div class="qtext">${q.questionText}</div>
        ${choices}${img}${ans}
        <div class="attribution">${q.source} · page ${q.page}${q.section ? ' · ' + q.section : ''}</div>
      </div>`;
    })
    .join('');
}

async function doSearch() {
  const query = $('searchQuery').value.trim();
  if (!query) return toast('Enter a search query', true);
  $('results').innerHTML = '<div class="qcard">Searching…</div>';
  try {
    const { results } = await api('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        category: $('fCategory').value || undefined,
        difficulty: $('fDifficulty').value || undefined,
        source: $('fSource').value || undefined,
        limit: 8,
      }),
    });
    renderQuestions(results, true);
  } catch (e) {
    toast(e.message, true);
  }
}

async function browseQuestions() {
  $('results').innerHTML = '<div class="qcard">Loading…</div>';
  const params = new URLSearchParams({ limit: '30' });
  if ($('fCategory').value) params.set('category', $('fCategory').value);
  if ($('fDifficulty').value) params.set('difficulty', $('fDifficulty').value);
  if ($('fSource').value) params.set('source', $('fSource').value);
  try {
    const { questions } = await api('/questions?' + params.toString());
    renderQuestions(questions, false);
  } catch (e) {
    toast(e.message, true);
  }
}

// Drag & drop
const dz = $('dropzone');
['dragover', 'dragenter'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
);
dz.addEventListener('drop', (e) => {
  $('fileInput').files = e.dataTransfer.files;
  doUpload();
});
dz.addEventListener('click', (e) => { if (e.target === dz || e.target.classList.contains('dz-inner')) $('fileInput').click(); });

fillSelect($('fCategory'), CATEGORIES, 'Any category');
fillSelect($('fDifficulty'), DIFFICULTIES, 'Any difficulty');
loadConfig();
loadAll();
pollIngest();
