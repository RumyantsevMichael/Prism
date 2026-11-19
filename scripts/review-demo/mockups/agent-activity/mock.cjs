// Mockups for "See running agents and launched sessions at a glance": injects proposed content into the running demo review app.
// Usage: node mock.cjs <review app url> <output folder>
const { chromium } = require('playwright');
const [base, out] = process.argv.slice(2);
const now = Date.now();
const iso = (min) => new Date(now + min * 60000).toISOString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const avatar = (name, { live = true, breathing = false, expired = false } = {}) => `<prism-avatar kind="agent" name="${esc(name)}" size="sm"${live ? ' live' : ''}${breathing ? ' breathing' : ''}${expired ? ' expired' : ''}></prism-avatar>`;
// One agent line: the harness and the model as quiet text after the name; the model is left out when Prism cannot be sure of it.
const who = (name, host, model) => `<span class="ag-who"><span class="ag-name">${esc(name)}</span><span class="ag-kind">${esc([host || 'Agent', model].filter(Boolean).join(' · '))}</span></span>`;
const slice = (t) => `<a class="ag-link" href="#">${esc(t)}</a>`;
const launchRow = ({ initiative, host, model, state, tone, activity, sliceTitle, time, reason, action, breathing }) => `
<li class="ag-row ag-launch">
  ${avatar(host, { live: state === 'Running', breathing })}
  <div class="ag-main">
    <div class="ag-line">${who(initiative, host, model)}</div>
    <div class="ag-sub">${activity ? `${esc(activity)} · ${slice(sliceTitle)}` : ''}${reason ? `<span class="ag-reason">${esc(reason)}</span>` : ''}</div>
  </div>
  <div class="ag-end"><prism-badge variant="status" tone="${tone}">${esc(state)}</prism-badge><span class="ag-time">${esc(time)}</span>${action ?? ''}</div>
</li>`;
const claimRow = ({ name, host, model, activity, sliceTitle, left, expired }) => `
<li class="ag-row${expired ? ' is-expired' : ''}">
  ${avatar(name, { live: !expired, expired })}
  <div class="ag-main">
    <div class="ag-line">${who(name, host, model)}</div>
    <div class="ag-sub">${esc(activity)} · ${slice(sliceTitle)}</div>
  </div>
  <div class="ag-end"><span class="ag-time">${esc(left)}</span></div>
</li>`;
const group = (title, rows) => `<p class="presence-group">${title}</p><ul class="ag-list">${rows.join('')}</ul>`;
const footer = `<div class="ag-foot"><p class="presence-note">Runs launched from this app show their exact host and model. Your own sessions show what their host tells Prism.</p><prism-button size="sm" variant="ghost" class="ag-all"><prism-icon name="play" size="xs"></prism-icon><span>All launched sessions</span></prism-button></div>`;
const LAUNCHED = [
  launchRow({ initiative: 'Harden request retries', host: 'Claude Code', model: 'Opus 5.5', state: 'Running', tone: 'accent', activity: 'implementation', sliceTitle: 'Emit retry metrics', time: '12m 05s', breathing: true, action: '<prism-button size="sm" variant="ghost">Stop</prism-button>' }),
  launchRow({ initiative: 'Export activity reports', host: 'Claude Code', model: 'Fable 5.2', state: 'Waiting for you', tone: 'warning', reason: 'Asks you to approve the design of Signed export.', time: '41m 10s', action: '<prism-button size="sm" variant="primary">Answer</prism-button>' }),
  launchRow({ initiative: 'Index activity for search', host: 'Codex', model: 'gpt-5.5-codex', state: 'Failed', tone: 'danger', reason: 'The provider does not offer gpt-5.5-codex for this account. Ended 4 min ago.', time: '8s', action: '<prism-button size="sm" variant="ghost">Open</prism-button>' })
];
const ELSEWHERE = [
  claimRow({ name: 'Dana on studio-mac', host: 'Codex', model: 'gpt-5.5', activity: 'design', sliceTitle: 'Authorized downloads', left: '22 min left' }),
  claimRow({ name: 'Michael on mbp', host: 'Claude Code', model: '', activity: 'implementation', sliceTitle: 'Retry timed-out requests until a total deadline', left: '30 min left' }),
  claimRow({ name: 'Claude on vm', host: '', model: '', activity: 'implementation', sliceTitle: 'Stop at the total deadline', left: '9 min left' })
];
const EXPIRED = [claimRow({ name: 'Michael on work-mac', host: 'Claude Code', model: 'Opus 5', activity: 'design', sliceTitle: 'Retry metrics dashboard', left: 'expired 2 h ago', expired: true })];
const SCENES = {
  menu: { button: { avatars: ['Claude Code', 'Dana on studio-mac', 'Michael on mbp'], more: 2, text: '5 working', badge: ['1 failed', 'danger'], badge2: ['1 waits', 'warning'] }, body: group('Launched on this computer', LAUNCHED) + group('Working in other sessions', ELSEWHERE) + group('Claims that expired', EXPIRED) + footer },
  quiet: { button: { avatars: ['Dana on studio-mac'], text: '1 working' }, body: group('Launched on this computer', [`<li class="ag-empty">Nothing launched is running. Launch an initiative from its page.</li>`]) + group('Working in other sessions', [ELSEWHERE[0]]) + footer },
  none: { button: { avatars: [], text: 'No agents' }, body: `<p class="presence-none">No agent is working on these initiatives, and nothing launched runs on this computer.</p>` + footer }
};
const CSS = `

.ag-list{list-style:none;margin:0 0 var(--prism-space-2) 0;padding:0;display:flex;flex-direction:column}
.ag-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:var(--prism-space-1) var(--prism-space-3);align-items:start;padding:var(--prism-space-2) 0;border-top:1px solid var(--prism-border-subtle)}
.ag-row:first-child{border-top:0}
.ag-row prism-avatar{margin-top:2px}
.ag-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.ag-who{display:flex;flex-wrap:wrap;gap:0 var(--prism-space-2);align-items:baseline;min-width:0}
.ag-name{font-weight:600;color:var(--prism-text);overflow-wrap:anywhere}
.ag-kind{color:var(--prism-text-muted);font-size:var(--prism-font-size-sm)}
.ag-sub{color:var(--prism-text);font-size:var(--prism-font-size-sm);overflow-wrap:anywhere}
.ag-reason{display:block;color:var(--prism-text-muted)}
.ag-link{color:var(--prism-accent-text,var(--prism-accent))}
.ag-end{display:flex;flex-direction:column;align-items:flex-end;gap:var(--prism-space-1);white-space:nowrap}
.ag-time{color:var(--prism-text-muted);font-size:var(--prism-font-size-sm);font-variant-numeric:tabular-nums}
.is-expired .ag-name,.is-expired .ag-sub{color:var(--prism-text-muted)}
.ag-empty{color:var(--prism-text-muted);font-size:var(--prism-font-size-sm);padding:var(--prism-space-2) 0}
.ag-foot{display:flex;flex-direction:column;gap:var(--prism-space-2);align-items:flex-start;border-top:1px solid var(--prism-border-subtle);padding-top:var(--prism-space-2)}
.ag-foot .presence-note{margin:0}
.ag-corner{position:absolute;top:-4px;right:-4px} #presence-button{position:relative}
.ag-btn-badges{display:inline-flex;gap:4px;margin-inline-start:6px}
@media (max-width:600px){.ag-row{grid-template-columns:auto minmax(0,1fr)} .ag-end{grid-column:2;flex-direction:row;align-items:center;justify-content:flex-start;flex-wrap:wrap} .ag-foot{flex-direction:column;align-items:stretch}}
`;
async function scenePresence(p, name) {
  await p.evaluate(({ scene }) => {
    const btn = document.querySelector('#presence-button');
    const stack = document.createElement('span'); stack.className = 'presence-stack';
    for (const n of scene.button.avatars) { const a = document.createElement('prism-avatar'); a.setAttribute('kind', 'agent'); a.setAttribute('name', n); a.setAttribute('size', 'sm'); a.setAttribute('live', ''); a.setAttribute('breathing', ''); stack.append(a); }
    if (scene.button.more) { const m = document.createElement('span'); m.className = 'presence-more'; m.textContent = `+${scene.button.more}`; stack.append(m); }
    const count = document.createElement('span'); count.className = 'presence-count'; count.textContent = scene.button.text;
    const kids = [...(scene.button.avatars.length ? [stack] : []), count];
    const badges = document.createElement('span'); badges.className = 'ag-btn-badges';
    for (const b of [scene.button.badge, scene.button.badge2].filter(Boolean)) { const e = document.createElement('prism-badge'); e.setAttribute('variant', 'status'); e.setAttribute('tone', b[1]); e.textContent = b[0]; badges.append(e); }
    if (badges.childElementCount) kids.push(badges);
    // On a phone the button keeps two avatars and one corner count of the launched runs that need you, as the Attention bell does.
    if (innerWidth <= 600) {
      stack.replaceChildren(...[...stack.querySelectorAll('prism-avatar')].slice(0, 2));
      kids.splice(kids.indexOf(badges), badges.childElementCount ? 1 : 0);
      const need = (scene.button.badge ? 1 : 0) + (scene.button.badge2 ? 1 : 0);
      if (need) { const c = document.createElement('prism-badge'); c.className = 'ag-corner'; c.setAttribute('size', 'sm'); c.setAttribute('tone', scene.button.badge ? 'danger' : 'warning'); c.textContent = String(need); c.setAttribute('aria-label', `${need} launched runs need you`); kids.push(c); }
    }
    btn.replaceChildren(...kids);
    const pop = document.querySelector('#presence');
    pop.setAttribute('heading', 'Agents');
    const h = pop.querySelector('.prism-popover-heading'); if (h) h.textContent = 'Agents';
    pop.querySelector('.presence-content').innerHTML = scene.body;
  }, { scene: SCENES[name] });
}
(async () => {
  const b = await chromium.launch();
  const shot = async (file, width, theme, fn) => {
    const phone = width < 600;
    const ctx = await b.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, bypassCSP: true, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage();
    await fn(p, ctx);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${out}/${file}-${width}-${theme}.png` });
    await ctx.close();
  };
  const open = async (p, artifact) => { const u = new URL('review', base); u.searchParams.set('artifact', artifact); await p.goto(u.href); await p.waitForTimeout(2500); await p.addStyleTag({ content: CSS }); };
  for (const [scene, width, theme] of [['menu', 1440, 'light'], ['menu', 1440, 'dark'], ['menu', 390, 'light'], ['menu', 390, 'dark'], ['menu', 320, 'light'], ['quiet', 1440, 'light'], ['none', 1440, 'light']]) {
    await shot(`agents-${scene}`, width, theme, async (p) => {
      await open(p, 'roadmap');
      await scenePresence(p, scene);
      await p.click('#presence-button');
      await p.waitForTimeout(500);
      await scenePresence(p, scene);
    });
  }
  // The slice page's claim strip and the Launched sessions page, with the harness and model named.
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light']]) {
    await shot('slice-claim', width, theme, async (p) => {
      await open(p, 'slice:retry-hardening/retry-metrics');
      await p.evaluate(() => { for (const c of document.querySelectorAll('prism-claim')) c.setAttribute('host', 'Claude Code · Opus 5.5'); });
      await p.locator('prism-claim[variant="strip"]').first().scrollIntoViewIfNeeded().catch(() => {});
    });
    await shot('launches', width, theme, async (p, ctx) => {
      await ctx.route('**/api/launches', (r) => r.fulfill({ json: { launches: [
        { id: 'launch-0000000000000001', initiative: 'retry-hardening', host: 'claude-code', hostLabel: 'Claude Code', model: 'Opus 5.5', checkout: '/Users/michael/SoftwareProjects/demo', launchedAt: iso(-12), runningMs: 725000, runs: 1, state: 'running', reason: null, exit: null, resumeCommand: null },
        { id: 'launch-0000000000000002', initiative: 'activity-reports', host: 'codex', hostLabel: 'Codex', model: 'gpt-5.5-codex', checkout: '/Users/michael/SoftwareProjects/demo', launchedAt: iso(-30), runningMs: 8000, runs: 1, state: 'failed', reason: 'The provider does not offer gpt-5.5-codex for this account.', exit: { code: 1, signal: null }, resumeCommand: { command: 'codex resume 019a…', cwd: '/Users/michael/SoftwareProjects/demo' } }
      ] } }));
      await open(p, 'launches'); await p.addStyleTag({ content: '.launch-row .action-error{display:none!important}' });
      await p.waitForTimeout(1000);
      // Proposed: a Model fact beside Host, which the launch record would keep from the host's own report.
      await p.evaluate(() => {
        const models = ['Opus 5.5', 'gpt-5.5-codex'];
        document.querySelectorAll('.launch-row').forEach((row, i) => {
          for (const dt of row.querySelectorAll('dt')) if (dt.textContent.trim() === 'Host') { const dd = dt.nextElementSibling; const ndt = dt.cloneNode(); ndt.textContent = 'Model'; const ndd = dd.cloneNode(); ndd.textContent = models[i]; dd.after(ndt, ndd); }
        });
      });
    });
  }
  await b.close();
})();
// Closed menu on phones, to see the header alone.
(async () => {
  const b = await chromium.launch();
  for (const width of [390, 320]) {
    const ctx = await b.newContext({ viewport: { width, height: 300 }, bypassCSP: true, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); const u = new URL('review', base); u.searchParams.set('artifact', 'roadmap');
    await p.goto(u.href); await p.waitForTimeout(2500); await p.addStyleTag({ content: CSS }); await scenePresence(p, 'menu'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/header-closed-${width}-light.png` }); await ctx.close();
  }
  await b.close();
})();
