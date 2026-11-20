// Denser agent listings for many agents: option C (aligned one-line rows in the menu) and option D (short menu + full Agents page as a table).
// Usage: node mock-dense.cjs <review app url> <output folder>
const { chromium } = require('playwright');
const [base, out] = process.argv.slice(2);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// kind: launched | claim | expired; need: true when it waits for the person.
const AGENTS = [
  { kind: 'launched', name: 'Index activity for search', host: 'Codex', model: 'gpt-5.5-codex', state: ['Failed', 'danger'], what: 'Ended 4 min ago: model not offered', time: '8s', action: 'Open', need: true },
  { kind: 'launched', name: 'Export activity reports', host: 'Claude Code', model: 'Fable 5.2', state: ['Waiting for you', 'warning'], what: 'design gate · Signed export', time: '41m', action: 'Answer', need: true },
  { kind: 'launched', name: 'Harden request retries', host: 'Claude Code', model: 'Opus 5.5', state: ['Running', 'accent'], what: 'implementation · Emit retry metrics', time: '12m', action: 'Stop' },
  { kind: 'launched', name: 'Audit log retention', host: 'Codex', model: 'gpt-5.5', state: ['Running', 'accent'], what: 'design · Retention policy', time: '3m', action: 'Stop' },
  { kind: 'claim', name: 'Dana on studio-mac', host: 'Codex', model: 'gpt-5.5', what: 'design · Authorized downloads', time: '22 min left' },
  { kind: 'claim', name: 'Michael on mbp', host: 'Claude Code', model: '', what: 'implementation · Retry timed-out requests until a total deadline', time: '30 min left' },
  { kind: 'claim', name: 'Michael on mbp', host: 'Claude Code', model: '', what: 'implementation · Stop at the total deadline', time: '28 min left' },
  { kind: 'claim', name: 'Sam on ci-runner-04', host: 'Claude Code', model: 'Sonnet 5.5', what: 'implementation · Signed report download link', time: '17 min left' },
  { kind: 'claim', name: 'Dana on studio-mac', host: 'Codex', model: 'gpt-5.5', what: 'design · Search index schema', time: '11 min left' },
  { kind: 'claim', name: 'Claude on vm', host: '', model: '', what: 'implementation · Retry metrics dashboard', time: '9 min left' },
  { kind: 'expired', name: 'Michael on work-mac', host: 'Claude Code', model: 'Opus 5', what: 'design · Export file naming', time: 'expired 2 h ago' },
  { kind: 'expired', name: 'Sam on ci-runner-02', host: 'Codex', model: 'gpt-5.5', what: 'implementation · Audit event schema', time: 'expired 5 h ago' }
];
const kindOf = (a) => [a.host || 'Agent', a.model].filter(Boolean).join(' · ');
const tile = (a) => a.kind === 'launched' ? (a.need ? ['play', a.state[1]] : ['play', 'accent']) : a.kind === 'expired' ? ['clock', 'neutral'] : ['agent', 'neutral'];
const button = (a) => a.action ? `<prism-button slot="action" size="sm" variant="${a.action === 'Answer' ? 'primary' : 'ghost'}">${a.action}</prism-button>` : '';
// Option C row: the kit's prism-row, so every row's columns line up: tile, title over description, kind, time, action.
const rowC = (a) => `<prism-row icon="${tile(a)[0]}" tone="${tile(a)[1]}">${esc(a.name)}<span slot="description">${esc(kindOf(a))} · ${esc(a.what)}</span>${a.state ? `<prism-badge slot="kind" variant="status" tone="${a.state[1]}">${esc(a.state[0])}</prism-badge>` : ''}<span slot="time">${esc(a.time)}</span>${button(a)}</prism-row>`;
const groupHead = (t, n) => `<p class="presence-group dz-group">${t} <prism-badge tone="neutral" size="sm">${n}</prism-badge></p>`;
const CAP = 6;
function menuC() {
  const need = AGENTS.filter((a) => a.need), launched = AGENTS.filter((a) => a.kind === 'launched' && !a.need), claims = AGENTS.filter((a) => a.kind === 'claim');
  // Needs you first, then launched here, then other sessions; the menu stops at six rows and the rest wait behind "Show all".
  let left = CAP; const take = (list) => { const shown = list.slice(0, Math.max(0, left)); left -= shown.length; return shown; };
  const sec = (t, list, all) => list.length ? `${groupHead(t, all.length)}<div class="prism-rows" role="list">${list.map(rowC).join('')}</div>` : '';
  const n = take(need), l = take(launched), c = take(claims);
  const hidden = AGENTS.length - n.length - l.length - c.length;
  return sec('Needs you', n, need) + sec('Launched on this computer', l, launched) + sec('Other sessions', c, claims) +
    `<div class="dz-foot"><prism-button size="sm" variant="ghost">Show all ${AGENTS.length} agents</prism-button><span class="presence-note">${hidden} more, including ${AGENTS.filter((a) => a.kind === 'expired').length} expired claims</span></div>`;
}
// Option D menu: counts and only what needs you; everything else lives on the Agents page.
function menuD() {
  const need = AGENTS.filter((a) => a.need);
  const counts = [['Launched on this computer', AGENTS.filter((a) => a.kind === 'launched').length, 'play'], ['Other sessions', AGENTS.filter((a) => a.kind === 'claim').length, 'agent'], ['Expired claims', AGENTS.filter((a) => a.kind === 'expired').length, 'clock']];
  return `${groupHead('Needs you', need.length)}<div class="prism-rows" role="list">${need.map(rowC).join('')}</div>
  <div class="dz-counts">${counts.map(([t, n, i]) => `<a class="dz-count" href="#"><prism-icon name="${i}" size="sm"></prism-icon><span>${t}</span><prism-badge tone="neutral" size="sm">${n}</prism-badge></a>`).join('')}</div>
  <div class="dz-foot"><prism-button size="sm" variant="secondary">Open Agents</prism-button></div>`;
}
// Option D page: one library table, a row per agent in shared columns, grouped like the menu.
function pageD() {
  const head = `<div class="prism-lib-row is-head" aria-hidden="true"><span>Agent</span><span>Host · model</span><span>Working on</span><span>State</span><span>Time</span><span></span></div>`;
  const row = (a) => `<div class="prism-lib-row${a.kind === 'expired' ? ' dz-expired' : ''}"><span class="prism-lib-title"><prism-icon class="prism-lib-kind" name="${tile(a)[0]}" size="sm"></prism-icon><span class="prism-lib-title-text"><a href="#">${esc(a.name)}</a></span></span><span class="prism-lib-cell">${esc(kindOf(a))}</span><span class="prism-lib-cell">${esc(a.what)}</span><span class="prism-lib-cell">${a.state ? `<prism-badge variant="status" tone="${a.state[1]}">${esc(a.state[0])}</prism-badge>` : (a.kind === 'expired' ? '<prism-badge variant="status" tone="neutral">Expired</prism-badge>' : '<prism-badge variant="status" tone="info">Working</prism-badge>')}</span><span class="prism-lib-cell">${esc(a.time)}</span><span class="prism-lib-cell">${a.action ? button(a).replace(' slot="action"', '') : ''}</span></div>`;
  const group = (t, list) => `<div class="prism-lib-group"><h3 class="prism-lib-group-name">${t} <prism-badge tone="neutral">${list.length}</prism-badge></h3></div>${list.map(row).join('')}`;
  return `<h1 class="dz-h1">Agents</h1><p class="dz-sub">Every agent working on this workspace, and every session launched on this computer.</p>
  <div class="dz-filters"><prism-segmented label="Show"><prism-option value="all" selected>All 12</prism-option><prism-option value="need">Needs you 2</prism-option><prism-option value="here">This computer 4</prism-option><prism-option value="other">Other sessions 6</prism-option></prism-segmented></div>
  <prism-lib-table class="dz-table">${head}${group('Needs you', AGENTS.filter((a) => a.need))}${group('Launched on this computer', AGENTS.filter((a) => a.kind === 'launched' && !a.need))}${group('Other sessions', AGENTS.filter((a) => a.kind === 'claim'))}${group('Claims that expired', AGENTS.filter((a) => a.kind === 'expired'))}</prism-lib-table>`;
}
const CSS = `
#presence .prism-rows{margin-bottom:var(--prism-space-2)}
.dz-group{display:flex;align-items:center;gap:var(--prism-space-2)}
.dz-foot{display:flex;flex-wrap:wrap;align-items:center;gap:var(--prism-space-2) var(--prism-space-3);border-top:1px solid var(--prism-border-subtle);padding-top:var(--prism-space-2)}
.dz-foot .presence-note{margin:0}
.dz-counts{display:flex;flex-direction:column;border-top:1px solid var(--prism-border-subtle);margin-bottom:var(--prism-space-2)}
.dz-count{display:flex;align-items:center;gap:var(--prism-space-2);padding:var(--prism-space-2) 0;color:var(--prism-text);text-decoration:none;border-bottom:1px solid var(--prism-border-subtle)}
.dz-count span{flex:1}
.dz-h1{margin:0 0 var(--prism-space-1)} .dz-sub{margin:0 0 var(--prism-space-4);color:var(--prism-text-muted)}
.dz-filters{margin-bottom:var(--prism-space-3)}
.dz-table{--prism-lib-columns:minmax(180px,1.3fr) minmax(130px,.9fr) minmax(200px,2fr) 130px 110px 80px}
.dz-expired a,.dz-expired .prism-lib-cell{color:var(--prism-text-muted)}
.ag-btn-badges{display:inline-flex;gap:4px;margin-inline-start:6px}
.ag-corner{position:absolute;top:-4px;right:-4px} #presence-button{position:relative}
`;
async function setButton(p) {
  await p.evaluate(() => {
    const btn = document.querySelector('#presence-button');
    const stack = document.createElement('span'); stack.className = 'presence-stack';
    for (const n of ['Claude Code', 'Codex', 'Dana']) { const a = document.createElement('prism-avatar'); a.setAttribute('kind', 'agent'); a.setAttribute('name', n); a.setAttribute('size', 'sm'); a.setAttribute('live', ''); stack.append(a); }
    const more = document.createElement('span'); more.className = 'presence-more'; more.textContent = '+7'; stack.append(more);
    const count = document.createElement('span'); count.className = 'presence-count'; count.textContent = '10 working';
    const badges = document.createElement('span'); badges.className = 'ag-btn-badges';
    for (const [t, tone] of [['1 failed', 'danger'], ['1 waits', 'warning']]) { const e = document.createElement('prism-badge'); e.setAttribute('variant', 'status'); e.setAttribute('tone', tone); e.textContent = t; badges.append(e); }
    if (innerWidth <= 600) { more.remove(); stack.lastChild.remove(); const c = document.createElement('prism-badge'); c.className = 'ag-corner'; c.setAttribute('size', 'sm'); c.setAttribute('tone', 'danger'); c.textContent = '2'; btn.replaceChildren(stack, count, c); }
    else btn.replaceChildren(stack, count, badges);
  });
}
(async () => {
  const b = await chromium.launch();
  const shot = async (file, width, theme, fn) => {
    const phone = width < 600;
    const ctx = await b.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, bypassCSP: true, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage(); await fn(p); await p.waitForTimeout(700);
    await p.screenshot({ path: `${out}/${file}-${width}-${theme}.png` }); await ctx.close();
  };
  const open = async (p, artifact) => { const u = new URL('review', base); u.searchParams.set('artifact', artifact); await p.goto(u.href); await p.waitForTimeout(2500); await p.addStyleTag({ content: CSS }); await setButton(p); };
  const menu = (html) => async (p) => {
    await open(p, 'roadmap'); await p.click('#presence-button'); await p.waitForTimeout(400); await setButton(p);
    await p.evaluate((h) => { const pop = document.querySelector('#presence'); pop.querySelector('.prism-popover-heading').textContent = 'Agents'; pop.querySelector('.presence-content').innerHTML = h; }, html);
  };
  for (const [w, t] of [[1440, 'light'], [1440, 'dark'], [390, 'light']]) {
    await shot('optC-menu', w, t, menu(menuC()));
    await shot('optD-menu', w, t, menu(menuD()));
    await shot('optD-page', w, t, async (p) => { await open(p, 'launches'); await p.evaluate((h) => { document.querySelector('.launches').closest('.view, .entity, main, [data-view]')?.querySelector('h1')?.remove(); const l = document.querySelector('.launches'); l.innerHTML = h; for (const e of document.querySelectorAll('h1:not(.dz-h1)')) if (e.textContent.trim() === 'Launched sessions') e.remove(); for (const e of document.querySelectorAll('.page-sub, prism-page-sub')) e.remove(); }, pageD()); });
  }
  await b.close();
})();
