/* ═══════════════════════════════════════════════════════════
   FIM Dashboard — JavaScript
   Real-time WebSocket updates + REST API calls
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── Global state ──────────────────────────────────────────────
let allEvents    = [];
let allBaseline  = [];
let monitorRunning = false;
let stats        = { total: 0, critical: 0, warning: 0, today: 0, baseline_files: 0 };

// ── Socket.IO ─────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  setLiveIndicator(true);
});

socket.on('disconnect', () => {
  setLiveIndicator(false);
});

socket.on('monitor_status', (data) => {
  setMonitorRunning(data.running);
});

socket.on('stats_update', (data) => {
  stats = data;
  renderStats();
  updateDonut();
});

socket.on('fim_event', (event) => {
  allEvents.unshift(event);
  stats.total++;
  if (event.severity === 'critical') stats.critical++;
  if (event.severity === 'warning')  stats.warning++;

  const today = new Date().toISOString().split('T')[0];
  if (event.timestamp && event.timestamp.startsWith(today)) stats.today++;

  renderStats();
  updateDonut();
  prependEventFeed(event);
  if (isEventTabVisible()) prependEventTable(event);
  showToast(event);
  updateNavBadge();
});

socket.on('paths_updated', (paths) => {
  renderPaths(paths);
});

socket.on('rescan_complete', (newStats) => {
  stats = newStats;
  renderStats();
  updateDonut();
  loadBaseline();
  showSimpleToast('Rescan complete', 'Baseline has been updated.', 'success');
});

// ── Utility ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString();
}

function shortHash(h) {
  return h ? h.slice(0, 12) + '…' : '—';
}

function chipClass(type) {
  const map = { modified: 'chip--modified', created: 'chip--created',
                deleted: 'chip--deleted', moved: 'chip--moved' };
  return map[type] || 'chip--info';
}

function severityClass(sev) {
  const map = { critical: 'severity-badge--critical', warning: 'severity-badge--warning', info: 'severity-badge--info' };
  return map[sev] || 'severity-badge--info';
}

function dotClass(sev) {
  const map = { critical: 'event-dot--critical', warning: 'event-dot--warning', info: 'event-dot--info' };
  return map[sev] || 'event-dot--info';
}

function escape(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Live indicator ────────────────────────────────────────────
function setLiveIndicator(live) {
  const el = $('#live-indicator');
  if (live) el.classList.remove('offline');
  else el.classList.add('offline');
}

// ── Monitor status ────────────────────────────────────────────
function setMonitorRunning(running) {
  monitorRunning = running;
  const dot   = $('#status-dot');
  const label = $('#status-label');
  dot.className = 'status-dot' + (running ? ' running' : '');
  label.textContent = running ? 'Running' : 'Stopped';
}

// ── Stats rendering ───────────────────────────────────────────
function renderStats() {
  $('#stat-baseline').textContent = stats.baseline_files ?? '—';
  $('#stat-total').textContent    = stats.total          ?? '—';
  $('#stat-critical').textContent = stats.critical       ?? '—';
  $('#stat-today').textContent    = stats.today          ?? '—';
  $('#recent-count').textContent  = allEvents.length + ' events';
}

// ── Donut chart ───────────────────────────────────────────────
function updateDonut() {
  const total    = stats.total || 0;
  const critical = stats.critical || 0;
  const warning  = stats.warning  || 0;
  const info     = total - critical - warning;
  const circ     = 2 * Math.PI * 70; // 439.8

  $('#donut-total-text').textContent = total;
  $('#legend-critical').textContent  = critical;
  $('#legend-warning').textContent   = warning;
  $('#legend-info').textContent      = Math.max(0, info);

  if (total === 0) {
    $('#donut-critical').setAttribute('stroke-dasharray', `0 ${circ}`);
    $('#donut-warning').setAttribute('stroke-dasharray',  `0 ${circ}`);
    return;
  }

  const critLen = (critical / total) * circ;
  const warnLen = (warning  / total) * circ;
  const critOffset = circ / 4;                 // start at top
  const warnOffset = critOffset - critLen;

  $('#donut-critical').setAttribute('stroke-dasharray', `${critLen} ${circ - critLen}`);
  $('#donut-critical').setAttribute('stroke-dashoffset', critOffset);
  $('#donut-warning').setAttribute('stroke-dasharray',  `${warnLen} ${circ - warnLen}`);
  $('#donut-warning').setAttribute('stroke-dashoffset',  warnOffset);
}

// ── Event feed (dashboard) ────────────────────────────────────
function renderEventFeed() {
  const feed = $('#recent-feed');
  if (allEvents.length === 0) {
    feed.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <p>No events yet. Start monitoring to detect changes.</p>
    </div>`;
    return;
  }
  feed.innerHTML = allEvents.slice(0, 50).map(eventFeedRow).join('');
}

function prependEventFeed(ev) {
  const feed = $('#recent-feed');
  const empty = feed.querySelector('.empty-state');
  if (empty) feed.innerHTML = '';
  feed.insertAdjacentHTML('afterbegin', eventFeedRow(ev));
  // keep max 50
  const rows = feed.querySelectorAll('.event-row');
  rows.forEach((r, i) => { if (i >= 50) r.remove(); });
  $('#recent-count').textContent = allEvents.length + ' events';
}

function eventFeedRow(ev) {
  return `<div class="event-row">
    <span class="event-dot ${dotClass(ev.severity)}"></span>
    <div class="event-body">
      <div class="event-path" title="${escape(ev.path)}">${escape(ev.path)}</div>
      <div class="event-meta">${fmtDate(ev.timestamp)}</div>
    </div>
    <span class="event-type-chip ${chipClass(ev.event_type)}">${escape(ev.event_type)}</span>
  </div>`;
}

// ── Events table ──────────────────────────────────────────────
function renderEventsTable(events) {
  const tbody = $('#events-tbody');
  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No events recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = events.map(eventTableRow).join('');
}

function prependEventTable(ev) {
  const tbody = $('#events-tbody');
  const empty = tbody.querySelector('.table-empty');
  if (empty) tbody.innerHTML = '';
  tbody.insertAdjacentHTML('afterbegin', eventTableRow(ev));
}

function eventTableRow(ev) {
  return `<tr>
    <td>${fmtDate(ev.timestamp)}</td>
    <td><span class="event-type-chip ${chipClass(ev.event_type)}">${escape(ev.event_type)}</span></td>
    <td><span class="severity-badge ${severityClass(ev.severity)}">${escape(ev.severity)}</span></td>
    <td class="path-cell" title="${escape(ev.path)}">${escape(ev.path)}</td>
    <td class="hash-cell" title="${escape(ev.old_hash)}">${shortHash(ev.old_hash)}</td>
    <td class="hash-cell" title="${escape(ev.new_hash)}">${shortHash(ev.new_hash)}</td>
  </tr>`;
}

function isEventTabVisible() {
  return $('#tab-events').classList.contains('active');
}

// ── Baseline table ────────────────────────────────────────────
function renderBaselineTable(files) {
  const tbody = $('#baseline-tbody');
  if (!files || files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No baseline data. Add a watch path and start monitoring.</td></tr>';
    return;
  }
  tbody.innerHTML = files.map(f => `<tr>
    <td class="path-cell" title="${escape(f.path)}">${escape(f.path)}</td>
    <td class="hash-cell" title="${escape(f.hash)}">${shortHash(f.hash)}</td>
    <td>${fmt(f.size)}</td>
    <td>${fmtDate(new Date(f.mtime * 1000).toISOString())}</td>
    <td>${fmtDate(f.created_at)}</td>
  </tr>`).join('');
}

// ── Paths list ────────────────────────────────────────────────
function renderPaths(paths) {
  const list = $('#paths-list');
  if (!paths || paths.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <p>No watch paths configured.</p>
    </div>`;
    return;
  }
  list.innerHTML = paths.map(p => `
    <div class="path-item">
      <div class="path-item-info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="path-item-text">
          <div class="path-item-path" title="${escape(p.path)}">${escape(p.path)}</div>
          <div class="path-item-meta">${p.recursive ? 'Recursive' : 'Non-recursive'} · Added ${fmtDate(p.added_at)}</div>
        </div>
      </div>
      <button class="btn btn-icon" onclick="removePath('${escape(p.path)}')" title="Remove path">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  `).join('');
}

// ── Toast notifications ───────────────────────────────────────
function showToast(event) {
  const titles = { modified: 'File Modified', created: 'File Created', deleted: 'File Deleted', moved: 'File Moved' };
  const title  = titles[event.event_type] || 'FIM Alert';
  const body   = event.path.length > 60 ? '…' + event.path.slice(-57) : event.path;
  showSimpleToast(title, body, event.severity);
}

function showSimpleToast(title, body, severity) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast toast--${severity}`;
  el.innerHTML = `<div><div class="toast-title">${escape(title)}</div><div class="toast-body">${escape(body)}</div></div>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 320);
  }, 4500);
}

// ── Nav event badge ───────────────────────────────────────────
function updateNavBadge() {
  const badge = $('#nav-event-badge');
  const count = allEvents.length;
  badge.textContent = count > 99 ? '99+' : count;
  badge.setAttribute('data-count', count);
  badge.style.display = count > 0 ? '' : 'none';
}

// ── API helpers ───────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

// ── Load initial data ─────────────────────────────────────────
async function loadAll() {
  const [statsData, eventsData, baselineData, pathsData, statusData] = await Promise.all([
    api('/api/stats'),
    api('/api/events?limit=200'),
    api('/api/baseline'),
    api('/api/paths'),
    api('/api/monitor/status'),
  ]);

  stats       = statsData;
  allEvents   = eventsData;
  allBaseline = baselineData;

  renderStats();
  updateDonut();
  renderEventFeed();
  renderEventsTable(allEvents);
  renderBaselineTable(allBaseline);
  renderPaths(pathsData);
  setMonitorRunning(statusData.running);
  updateNavBadge();
}

async function loadBaseline() {
  allBaseline = await api('/api/baseline');
  renderBaselineTable(applyBaselineFilter(allBaseline));
}

// ── Filters ───────────────────────────────────────────────────
function applyEventFilters(events) {
  const sev    = $('#filter-severity').value;
  const type   = $('#filter-type').value;
  const search = $('#filter-search').value.toLowerCase();
  return events.filter(e =>
    (!sev    || e.severity   === sev)  &&
    (!type   || e.event_type === type) &&
    (!search || e.path.toLowerCase().includes(search))
  );
}

function applyBaselineFilter(files) {
  const search = $('#baseline-search').value.toLowerCase();
  return files.filter(f => !search || f.path.toLowerCase().includes(search));
}

['filter-severity','filter-type','filter-search'].forEach(id => {
  document.getElementById(id).addEventListener('input', () =>
    renderEventsTable(applyEventFilters(allEvents))
  );
});

document.getElementById('baseline-search').addEventListener('input', () =>
  renderBaselineTable(applyBaselineFilter(allBaseline))
);

// ── Tab navigation ────────────────────────────────────────────
$$('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = item.dataset.tab;
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = $(`#tab-${tab}`);
    if (panel) panel.classList.add('active');

    const titles = { dashboard: 'Dashboard', events: 'Events', baseline: 'Baseline', paths: 'Watch Paths' };
    $('#page-title').textContent = titles[tab] || tab;

    // Refresh baseline when switching to that tab
    if (tab === 'baseline') loadBaseline();
  });
});

// ── Monitor controls ──────────────────────────────────────────
$('#btn-start').addEventListener('click', async () => {
  await api('/api/monitor/start', { method: 'POST' });
});

$('#btn-stop').addEventListener('click', async () => {
  await api('/api/monitor/stop', { method: 'POST' });
});

// ── Rescan ────────────────────────────────────────────────────
$('#btn-rescan').addEventListener('click', async () => {
  showSimpleToast('Rescan Started', 'Rebuilding baseline for all paths…', 'info');
  await api('/api/monitor/rescan', { method: 'POST' });
});

// ── Clear events (UI only) ────────────────────────────────────
$('#btn-clear-events').addEventListener('click', () => {
  allEvents = [];
  renderEventFeed();
  renderEventsTable([]);
  stats.total = 0; stats.critical = 0; stats.warning = 0; stats.today = 0;
  renderStats();
  updateDonut();
  updateNavBadge();
});

// ── Add watch path ────────────────────────────────────────────
$('#add-path-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path      = $('#path-input').value.trim();
  const recursive = $('#path-recursive').checked;
  if (!path) return;

  const res = await api('/api/paths', {
    method: 'POST',
    body: JSON.stringify({ path, recursive }),
  });

  if (res.error) {
    showSimpleToast('Error', res.error, 'critical');
  } else {
    $('#path-input').value = '';
    showSimpleToast('Path Added', path, 'success');
    // paths_updated socket event will refresh the list
    // also rebuild stats
    const s = await api('/api/stats');
    stats = s;
    renderStats();
  }
});

// ── Remove watch path ─────────────────────────────────────────
async function removePath(path) {
  await api('/api/paths', {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  });
  showSimpleToast('Path Removed', path, 'warning');
}

// ── Boot ──────────────────────────────────────────────────────
loadAll();
