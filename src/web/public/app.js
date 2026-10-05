/* Locale Engine front-end. Plain JavaScript, no build step. All text goes in through textContent, never innerHTML. */
(function () {
  'use strict';
  const root = document.getElementById('app');
  const LANGS = [['en-NL', 'English (Netherlands)'], ['en-GB', 'English (UK)'], ['de-DE', 'German (Germany)'], ['de-AT', 'German (Austria)'], ['de-CH', 'German (Switzerland)'], ['it-IT', 'Italian']];
  let me = null;
  let view = 'new';
  let timer = null;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const money = (n) => 'USD ' + Number(n || 0).toFixed(2);
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const pill = (t) => h('span', { class: 'pill ' + t }, t.replace(/_/g, ' ').toLowerCase());

  async function api(path, opts) {
    const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, opts, opts && opts.body ? { body: JSON.stringify(opts.body) } : {}));
    if (res.status === 401 && path !== '/login') { if (me) { me = null; render(); } throw new Error('sign in first'); }
    const ctype = res.headers.get('content-type') || '';
    const data = ctype.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error && data.error.message) || 'request failed (' + res.status + ')');
    return data;
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  // ---- layout -----------------------------------------------------------------------------------------------------
  function shell(content) {
    const tabs = [['new', 'New translation'], ['jobs', 'My jobs']].concat(me.role === 'admin' ? [['admin', 'Admin']] : []);
    return h('div', null,
      h('header', { class: 'bar' }, h('div', { class: 'wrap' },
        h('h1', null, 'Locale Engine'),
        h('nav', null, tabs.map(([k, label]) => h('button', { class: view === k || (view === 'job' && k === 'jobs') ? 'on' : '', onclick: () => go(k) }, label))),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, me.username + ' · today ' + money(me.spent_today_usd) + ' of ' + money(me.daily_limit_usd)),
        h('button', { class: 'ghost', onclick: logout }, 'Sign out'))),
      me.demo && h('div', { class: 'demo' }, 'Demo mode: no AI is used, the translations are placeholders ([mock …]). Add API keys and restart without LOCALE_WEB_DEMO for real results.'),
      h('div', { class: 'wrap' }, content));
  }

  function go(v, arg) { stopTimer(); view = v; render(arg); }

  async function logout() { try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignore */ } me = null; render(); }

  async function render(arg) {
    stopTimer();
    if (!me) {
      try { me = await api('/me'); } catch (e) { me = null; }
    }
    root.replaceChildren();
    if (!me) return root.append(loginView());
    try {
      me = await api('/me');
      if (view === 'new') root.append(shell(newView()));
      else if (view === 'jobs') root.append(shell(await jobsView()));
      else if (view === 'job') root.append(shell(await jobView(arg)));
      else if (view === 'admin') root.append(shell(await adminView()));
    } catch (e) { root.append(shell(h('p', { class: 'err' }, e.message))); }
  }

  // ---- login ------------------------------------------------------------------------------------------------------
  function loginView() {
    const err = h('p', { class: 'err' });
    const u = h('input', { type: 'text', autocomplete: 'username', autofocus: true });
    const p = h('input', { type: 'password', autocomplete: 'current-password' });
    const submit = async (e) => {
      e.preventDefault(); err.textContent = '';
      try { me = await api('/login', { method: 'POST', body: { username: u.value, password: p.value } }); view = 'new'; render(); }
      catch (x) { err.textContent = x.message; }
    };
    return h('form', { class: 'card login', onsubmit: submit }, h('h2', null, 'Locale Engine'), h('p', { class: 'muted' }, 'Sign in to translate and localize pages.'),
      h('label', null, 'User name'), u, h('label', null, 'Password'), p, err, h('p', null, h('button', { class: 'primary', type: 'submit' }, 'Sign in')));
  }

  // ---- new translation --------------------------------------------------------------------------------------------
  function newView() {
    let mode = 'url';
    const err = h('p', { class: 'err' });
    const url = h('input', { type: 'url', placeholder: 'https://example.nl/pompen/centrifugaalpompen' });
    const text = h('textarea', { placeholder: 'Paste the page text or HTML here' });
    const format = h('select', null, h('option', { value: 'text' }, 'Plain text'), h('option', { value: 'html' }, 'HTML'), h('option', { value: 'markdown' }, 'Markdown'));
    const file = h('input', { type: 'file', accept: '.html,.htm,.md,.markdown,.txt' });
    const keyword = h('input', { type: 'text', placeholder: 'optional, in the source language' });
    const boxes = LANGS.map(([code, name]) => h('input', { type: 'checkbox', value: code, checked: true }));
    const urlBox = h('div', null, h('label', null, 'Page address'), url, h('p', { class: 'muted small' }, 'Pages that block crawlers cannot be fetched: save the page (Ctrl+S) and use "Paste or upload".'));
    const textBox = h('div', { class: 'hide', style: 'display:none' }, h('label', null, 'Content'), text, h('div', { class: 'row' }, h('div', null, h('label', null, 'Format'), format), h('div', null, h('label', null, 'Or upload a file'), file)));
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      text.value = await f.text();
      format.value = /\.html?$/i.test(f.name) ? 'html' : /\.(md|markdown)$/i.test(f.name) ? 'markdown' : 'text';
    });
    const setMode = (m) => { mode = m; urlBox.style.display = m === 'url' ? '' : 'none'; textBox.style.display = m === 'text' ? '' : 'none'; };
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Start translation');
    const submit = async (e) => {
      e.preventDefault(); err.textContent = '';
      const targets = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!targets.length) { err.textContent = 'Pick at least one language.'; return; }
      const input = mode === 'url' ? { kind: 'url', url: url.value.trim() } : { kind: 'text', text: text.value, format: format.value, name: (file.files[0] && file.files[0].name) || undefined };
      btn.disabled = true;
      try { const job = await api('/jobs', { method: 'POST', body: { input, targets, keyword: keyword.value.trim() || undefined } }); go('job', job.id); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    };
    return h('form', { class: 'card', onsubmit: submit }, h('h2', null, 'New translation'),
      h('div', { class: 'chips' },
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: true, onchange: () => setMode('url') }), 'Web address'),
        h('label', null, h('input', { type: 'radio', name: 'mode', onchange: () => setMode('text') }), 'Paste or upload')),
      urlBox, textBox,
      h('label', null, 'Languages'), h('div', { class: 'chips' }, LANGS.map(([code, name], i) => h('label', null, boxes[i], name))),
      h('label', null, 'Main keyword'), keyword,
      h('p', { class: 'muted small' }, 'Each job is capped at its own spending limit and counts against your daily limit. Results are drafts: have a native speaker review them before publishing.'),
      err, btn);
  }

  // ---- job list ---------------------------------------------------------------------------------------------------
  async function jobsView() {
    const { jobs } = await api('/jobs' + (me.role === 'admin' && view === 'jobs' && window.__all ? '?all=1' : ''));
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (busy) timer = setInterval(() => render(), 4000);
    const rows = jobs.map((j) => h('tr', { class: 'click', onclick: () => go('job', j.id) },
      h('td', null, pill(j.status)), h('td', null, j.input_ref.length > 70 ? j.input_ref.slice(0, 70) + '…' : j.input_ref),
      h('td', null, j.targets.join(', ')), h('td', null, when(j.created_at)), h('td', null, j.status === 'done' ? money(j.cost_usd) : '')));
    return h('div', { class: 'card' }, h('h2', null, 'My jobs'),
      jobs.length ? h('table', null, h('thead', null, h('tr', null, ['Status', 'Source', 'Languages', 'Started', 'Cost'].map((t) => h('th', null, t)))), h('tbody', null, rows)) : h('p', { class: 'muted' }, 'No jobs yet.'));
  }

  // ---- one job ----------------------------------------------------------------------------------------------------
  async function jobView(id) {
    const job = await api('/jobs/' + id);
    const running = job.status === 'queued' || job.status === 'running';
    if (running) timer = setInterval(() => render(id), 3000);
    const head = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', null, 'Translation job'), pill(job.status), h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: () => go('jobs') }, 'Back'),
        !running && h('button', { class: 'ghost', onclick: async () => { if (confirm('Delete this job and its files?')) { await api('/jobs/' + id, { method: 'DELETE' }); go('jobs'); } } }, 'Delete')),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Source'), h('span', null, job.input_ref), h('span', { class: 'muted' }, 'Languages'), h('span', null, job.targets.join(', ')),
        h('span', { class: 'muted' }, 'Started'), h('span', null, when(job.created_at)), job.status === 'done' && h('span', { class: 'muted' }, 'Cost'), job.status === 'done' && h('span', null, me.demo ? 'none (demo, no AI used)' : money(job.cost_usd))),
      running && h('p', { class: 'muted' }, job.status === 'queued' ? 'Waiting in the queue…' : 'Translating, checking and exporting. This usually takes one to a few minutes.'),
      job.status === 'failed' && h('p', { class: 'err' }, job.error));
    if (job.status !== 'done') return head;
    const s = job.summary;
    const sum = h('div', { class: 'card' }, h('h3', null, 'Result'),
      h('p', { class: 'muted small' }, 'Source: ' + s.source.locale + ', ' + s.source.segments + ' segments, ' + s.source.words + ' words. Written by: ' + s.providers.join(', ') + '.'),
      h('table', null, h('thead', null, h('tr', null, ['Language', 'Verdict', 'Score', 'Serious findings', 'Notes', 'To confirm', 'Changes'].map((t) => h('th', null, t)))),
        h('tbody', null, s.locales.map((l) => h('tr', null, h('td', null, l.locale), h('td', null, pill(l.verdict)), h('td', null, l.score.toFixed(1)), h('td', null, l.open_critical + l.open_major), h('td', null, l.open_minor), h('td', null, l.human_review), h('td', null, l.changes))))),
      s.warnings.length ? h('p', { class: 'muted small' }, 'Run notes: ' + s.warnings.join(' · ')) : null,
      h('p', { class: 'muted small' }, 'The score reflects the rule checks and the AI reviewer only; it is not a guarantee of quality. "To confirm" are segments a person must decide (business claims, legal text).'),
      h('div', { class: 'dl' },
        h('a', { class: 'btn', href: '/api/jobs/' + id + '/download.zip' }, 'Download everything (.zip)'),
        file(id, 'localization_report.xlsx', 'Excel report'), file(id, 'executive_summary.md', 'Summary'),
        s.locales.map((l) => [file(id, l.locale + '/page.html', l.locale + ' HTML'), file(id, l.locale + '/page.md', l.locale + ' Markdown')])));
    const holder = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading the side-by-side view…'));
    api('/jobs/' + id + '/report').then((r) => holder.replaceChildren(compare(r))).catch((e) => holder.replaceChildren(h('p', { class: 'err' }, e.message)));
    return h('div', null, head, sum, holder);
  }
  const file = (id, name, label) => h('a', { class: 'btn', href: '/api/jobs/' + id + '/file?name=' + encodeURIComponent(name) }, label);

  function fmt(text) {
    // inline link placeholders <a1>…</a1> shown as a dotted underline; everything else is text
    const out = []; const re = /<a\d+>([\s\S]*?)<\/a\d+>/g; let last = 0; let m;
    while ((m = re.exec(text))) { if (m.index > last) out.push(text.slice(last, m.index)); out.push(h('span', { class: 'lnk' }, m[1])); last = re.lastIndex; }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function compare(report) {
    const shown = new Set(report.locales.map((l) => l.locale));
    let only = false; let q = '';
    const tabs = h('div', { class: 'tabs' });
    const body = h('tbody');
    const recs = h('div');
    const draw = () => {
      tabs.replaceChildren(...report.locales.map((l) => h('button', { class: shown.has(l.locale) ? 'on' : '', onclick: () => { shown.has(l.locale) ? shown.delete(l.locale) : shown.add(l.locale); draw(); } }, l.locale)),
        h('label', { style: 'display:inline-flex;gap:6px;align-items:center;font-weight:500' }, h('input', { type: 'checkbox', checked: only, onchange: (e) => { only = e.target.checked; draw(); } }), 'only flagged'),
        h('input', { type: 'text', placeholder: 'search…', value: q, style: 'width:180px', oninput: (e) => { q = e.target.value.toLowerCase(); drawRows(); } }));
      drawRows();
    };
    const drawRows = () => {
      const ls = report.locales.filter((l) => shown.has(l.locale));
      const n = report.locales[0].segments.length;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const base = report.locales[0].segments[i];
        const cells = ls.map((l) => l.segments[i]);
        if (only && !cells.some((c) => c.human_review || c.notes.length)) continue;
        if (q && !(base.source.toLowerCase().includes(q) || cells.some((c) => c.final.toLowerCase().includes(q)))) continue;
        rows.push(h('tr', null, h('td', { class: 'small muted' }, base.id, h('br'), base.type), h('td', { class: 'src' }, fmt(base.source)),
          cells.map((c) => h('td', { class: c.human_review || c.notes.length ? 'flag' : '' }, fmt(c.final),
            c.changes.map((x) => h('span', { class: 'chg', title: x.rule }, x.from + ' → ' + x.to)),
            c.human_review && h('span', { class: 'note review' }, 'needs a human decision'),
            c.notes.map((x) => h('span', { class: 'note ' + (x.origin === 'deterministic' ? 'rule' : 'review') }, (x.origin === 'deterministic' ? 'rule' : 'review') + ' (' + x.severity + '): ' + x.text))))));
      }
      body.replaceChildren(...rows);
      head.replaceChildren(h('tr', null, h('th', null, 'Segment'), h('th', null, 'Original'), ls.map((l) => h('th', null, l.locale))));
    };
    const head = h('thead');
    recs.append(h('h3', null, 'Points to confirm'), ...report.locales.map((l) => h('details', null, h('summary', null, l.locale + ' (' + l.recommendations.length + ')'), h('ul', null, l.recommendations.map((r) => h('li', null, (r.segment ? '[' + r.segment + '] ' : '') + r.text))))));
    draw();
    return h('div', null, h('h3', null, 'Side by side'), tabs, h('div', { style: 'overflow:auto' }, h('table', { class: 'seg' }, head, body)), recs);
  }

  // ---- admin ------------------------------------------------------------------------------------------------------
  async function adminView() {
    const { users } = await api('/admin/users');
    const err = h('p', { class: 'err' });
    const nu = h('input', { type: 'text', placeholder: 'user name' });
    const np = h('input', { type: 'password', placeholder: 'password (10+ characters)' });
    const nl = h('input', { type: 'number', min: '0', step: '1', value: '10' });
    const nr = h('select', null, h('option', { value: 'user' }, 'user'), h('option', { value: 'admin' }, 'admin'));
    const create = async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api('/admin/users', { method: 'POST', body: { username: nu.value, password: np.value, role: nr.value, daily_limit_usd: Number(nl.value) } }); render(); }
      catch (x) { err.textContent = x.message; }
    };
    const patch = async (id, body) => { try { await api('/admin/users/' + id, { method: 'PATCH', body }); render(); } catch (x) { alert(x.message); } };
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'Users'),
        h('table', null, h('thead', null, h('tr', null, ['User', 'Role', 'Jobs', 'Spent today', 'Daily limit (USD)', ''].map((t) => h('th', null, t)))),
          h('tbody', null, users.map((u) => h('tr', null, h('td', null, u.username + (u.disabled ? ' (disabled)' : '')), h('td', null, u.role), h('td', null, u.jobs), h('td', null, money(u.spent_today_usd)),
            h('td', null, h('input', { type: 'number', min: '0', value: u.daily_limit_usd, style: 'width:90px', onchange: (e) => patch(u.id, { daily_limit_usd: Number(e.target.value) }) })),
            h('td', null, h('button', { class: 'ghost', onclick: () => patch(u.id, { disabled: !u.disabled }) }, u.disabled ? 'Enable' : 'Disable'), ' ',
              h('button', { class: 'ghost', onclick: () => { const p = prompt('New password for ' + u.username + ' (10+ characters)'); if (p) patch(u.id, { password: p }); } }, 'Reset password'))))))),
      h('form', { class: 'card', onsubmit: create }, h('h3', null, 'Add a user'), h('div', { class: 'row' }, nu, np, nr, nl), err, h('p', null, h('button', { class: 'primary', type: 'submit' }, 'Create user'))));
  }

  render();
})();
