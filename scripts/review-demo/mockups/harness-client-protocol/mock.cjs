// Mockups for "Reach any harness through one client protocol": injects proposed content into the running demo review app.
// Scenes: a permission request on Attention, the Coding agents section of Settings, and the host chooser and usage of an ACP agent.
// Usage: node mock.cjs <review app url> <output folder>
const { chromium } = require('playwright');
const [base, out] = process.argv.slice(2);
const now = Date.now();
const iso = (min) => new Date(now + min * 60000).toISOString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const badge = (text, tone = 'neutral') => `<prism-badge variant="status" tone="${tone}">${esc(text)}</prism-badge>`;

// Attention: a permission request lists under Needs you, beside the gates, and its sheet offers Allow and Refuse.
const PERMISSIONS = [
  { key: 'perm:1', action: 'Write probe.txt', reason: 'Gemini CLI asks before it runs a tool of kind edit.', initiative: 'Harden request retries', host: 'Gemini CLI', age: '2 min' },
  { key: 'perm:2', action: 'Run npm test', reason: 'Codex needs to run the tests outside its sandbox.', initiative: 'Export activity reports', host: 'Codex', age: '6 min' }
];
const permissionRow = (p) => `<prism-inbox-item value="${p.key}" icon="lock" tone="warning" unread>${esc(p.action)}<span slot="description">Permission · ${esc(p.initiative)} · ${esc(p.host)}</span><span slot="end">${esc(p.age)}</span></prism-inbox-item>`;
const permissionSheet = (p) => `<article class="gate attention-item gate-permission" aria-label="Permission">
  <header class="gate-head"><div class="gate-chips">${badge('Permission', 'warning')}<span class="attention-where">${esc(p.initiative)} · ${esc(p.host)}</span><span class="attention-time gate-time">asked ${esc(p.age)} ago</span></div>
  <h3 class="gate-question">${esc(p.host)} asks you to allow: ${esc(p.action)}</h3></header>
  <div class="gate-body"><div class="gate-main">
    <dl class="hc-facts"><dt>Initiative</dt><dd>${esc(p.initiative)}</dd><dt>Host</dt><dd>${esc(p.host)}</dd><dt>Action</dt><dd><code>${esc(p.action)}</code></dd><dt>Reason</dt><dd>${esc(p.reason)}</dd></dl>
    <p class="attention-footnote muted">The session waits until you answer. An allow covers this one request only.</p>
  </div>
  <div class="hc-answer">
    <prism-button variant="primary"><prism-icon name="lock" size="sm"></prism-icon><span>Allow</span></prism-button>
    <prism-button><span>Refuse</span></prism-button>
    <p class="settings-hint hc-hint">You confirm outside the browser.</p>
  </div></div>
</article>`;

// Settings: the Coding agents section lists every agent Prism can launch or install, with its details and actions.
const AGENTS = [
  { name: 'OpenCode', version: '2.3.1', marks: [['Installed', 'success'], ['Update 2.3.2', 'accent']], meta: 'SST · MIT', source: 'github.com/sst/opencode', description: 'The open source AI coding agent.', actions: ['Update', 'Remove'] },
  { name: 'Gemini CLI', version: '0.70.0', marks: [['Declared', 'neutral']], meta: 'Google · Apache-2.0', source: 'github.com/google-gemini/gemini-cli', description: 'Declared in acp-agents.json. Needs you to sign in: run gemini once in a terminal.', actions: [] },
  { name: 'Goose', version: '1.14.0', marks: [], meta: 'Block · Apache-2.0', source: 'github.com/block/goose', description: 'An open source, extensible AI agent.', actions: ['Install'] },
  { name: 'Amp', version: '0.0.17', marks: [], meta: 'Sourcegraph · Proprietary', source: 'ampcode.com', description: 'Cannot be installed: its build for linux-x86_64 lists no SHA-256 checksum.', actions: [], unavailable: true }
];
const agentRow = (a) => `<prism-row icon="agent" tone="${a.unavailable ? 'neutral' : 'accent'}" wrap>${esc(a.name)} <span class="hc-version">${esc(a.version)}</span>
  <span slot="description">${esc(a.meta)} · <a href="#">${esc(a.source)}</a></span>
  <span slot="detail">${esc(a.description)}</span>
  <span slot="kind" class="hc-marks">${a.marks.map(([t, tone]) => badge(t, tone)).join('')}</span>
  <span slot="action" class="hc-actions">${a.actions.map((t) => `<prism-button size="sm"${t === 'Install' || t === 'Update' ? ' variant="primary"' : ''}>${t}</prism-button>`).join('')}</span>
</prism-row>`;
const CODING_AGENTS = `<section class="settings-section" data-section="agents" aria-labelledby="settings-agents">
  <h3 id="settings-agents">Coding agents</h3>
  <p class="settings-hint">Claude Code and Codex run through Prism's own integrations. Prism launches every other agent here through the Agent Client Protocol.</p>
  <div class="prism-rows" role="list">${AGENTS.map(agentRow).join('')}</div>
  <p class="settings-hint hc-foot">From the ACP registry, read 3 min ago. Each install and update asks you to confirm outside the browser and runs no install script.</p>
</section>`;
const CODING_AGENTS_DOWN = CODING_AGENTS.replace(/<p class="settings-hint hc-foot">[^<]*<\/p>/, '<prism-banner tone="warning">The ACP registry cannot be read: it answered 503. Installed and declared agents stay usable; installs wait until it answers.</prism-banner>')
  .replace(/<prism-row icon="agent" tone="(accent|neutral)" wrap>(Goose|Amp)[\s\S]*?<\/prism-row>/g, '')
  .replace('<prism-button size="sm" variant="primary">Update</prism-button>', '').replace(badge('Update 2.3.2', 'accent'), '');

// Run configuration: the host chooser names each agent's reason, and the Agents page shows what an ACP agent reported.
const HOSTS = [
  { value: 'claude-code', label: 'Claude Code', detail: 'Prism\'s own integration.' },
  { value: 'codex', label: 'Codex', detail: 'Prism\'s own integration.' },
  { value: 'acp-opencode', label: 'OpenCode', detail: 'Installed 2.3.1 from the ACP registry.' },
  { value: 'acp-gemini', label: 'Gemini CLI', detail: 'Gemini CLI needs you to sign in before it can run: Log in with Google (opens a browser).', disabled: true },
  { value: 'acp-aider', label: 'Aider', detail: 'Aider did not start Prism\'s tools, so it cannot run Prism\'s workflow.', disabled: true },
  { value: 'acp-old', label: 'Old agent', detail: 'Old agent speaks ACP version 2, and Prism speaks version 1.', disabled: true }
];
const HOST_DIALOG = `<prism-dialog id="hc-hosts" heading="Settings of Harden request retries" size="lg" open>
  <p class="settings-hint">The coding agent that runs this initiative's coordinator.</p>
  <prism-choice label="Host" value="acp-opencode">${HOSTS.map((h) => `<prism-choice-option value="${h.value}"${h.disabled ? ' disabled' : ''}>${esc(h.label)}<span slot="detail">${esc(h.detail)}</span></prism-choice-option>`).join('')}</prism-choice>
</prism-dialog>`;

const CSS = `
.hc-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--prism-space-1) var(--prism-space-3);margin:0 0 var(--prism-space-3) 0}
.hc-facts dt{color:var(--prism-text-muted);font-size:var(--prism-font-size-sm)}
.hc-facts dd{margin:0;overflow-wrap:anywhere}
.hc-answer{display:flex;flex-wrap:wrap;gap:var(--prism-space-2);align-items:center}
.hc-hint{flex-basis:100%;margin:0}
.hc-version{color:var(--prism-text-muted);font-weight:400;font-variant-numeric:tabular-nums}
.hc-marks{display:inline-flex;gap:4px;flex-wrap:wrap}
.hc-actions{display:inline-flex;gap:var(--prism-space-2)}
.hc-foot{margin-top:var(--prism-space-3)}
`;

async function attentionScene(p) {
  await p.evaluate(({ rows, sheets }) => {
    const needs = document.querySelector('#attention-group-needs')?.closest('.attention-group')?.querySelector('prism-inbox');
    if (needs) needs.insertAdjacentHTML('afterbegin', rows);
    const count = document.querySelector('#attention-group-needs prism-badge'); if (count) count.textContent = String(Number(count.textContent || 0) + 2);
    for (const s of document.querySelectorAll('.attention-sheet')) s.hidden = true;
    for (const i of document.querySelectorAll('prism-inbox-item[selected]')) i.removeAttribute('selected');
    document.querySelector('.attention-detail').insertAdjacentHTML('beforeend', `<section class="attention-sheet" data-detail="perm:1">${sheets}</section>`);
    document.querySelector('prism-inbox-item[value="perm:1"]')?.setAttribute('selected', '');
  }, { rows: PERMISSIONS.map(permissionRow).join(''), sheets: permissionSheet(PERMISSIONS[0]) });
}
async function settingsScene(p, html) {
  await p.evaluate(({ html }) => {
    const dialog = document.getElementById('settings-dialog');
    const tree = document.getElementById('settings-sections');
    const about = tree.querySelector('prism-tree-item[value="about"]');
    about.insertAdjacentHTML('beforebegin', '<prism-tree-item value="agents" label="Coding agents"><prism-icon slot="start" name="agent" size="sm"></prism-icon></prism-tree-item>');
    dialog.querySelector('.settings-body').insertAdjacentHTML('beforeend', html);
    for (const s of dialog.querySelectorAll('.settings-section')) s.hidden = s.dataset.section !== 'agents';
    for (const i of tree.querySelectorAll('prism-tree-item')) i.toggleAttribute('selected', i.getAttribute('value') === 'agents');
    dialog.show();
  }, { html });
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
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    await shot('attention-permission', width, theme, async (p) => { await open(p, 'attention'); await attentionScene(p); });
    await shot('coding-agents', width, theme, async (p) => { await open(p, 'roadmap'); await settingsScene(p, CODING_AGENTS); });
    await shot('run-hosts', width, theme, async (p) => { await open(p, 'roadmap'); await p.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), HOST_DIALOG); });
    await shot('launch-usage', width, theme, async (p, ctx) => {
      await ctx.route('**/api/launches', (r) => r.fulfill({ json: { launches: [
        { id: 'launch-0000000000000001', initiative: 'retry-hardening', host: 'acp-opencode', hostLabel: 'OpenCode', model: 'fake-large', checkout: '/Users/michael/SoftwareProjects/demo', launchedAt: iso(-12), runningMs: 725000, runs: 1, state: 'running', reason: null, exit: null, resumeCommand: null },
        { id: 'launch-0000000000000002', initiative: 'activity-reports', host: 'acp-gemini', hostLabel: 'Gemini CLI', model: null, checkout: '/Users/michael/SoftwareProjects/demo', launchedAt: iso(-30), runningMs: 8000, runs: 1, state: 'failed', reason: 'Gemini CLI stopped: max_turn_requests.', exit: { code: 0, signal: null }, resumeCommand: null }
      ] } }));
      await open(p, 'launches'); await p.addStyleTag({ content: '.launch-row .action-error{display:none!important}' });
      await p.waitForTimeout(1000);
      // Proposed: Tokens, Context, and Cost facts after Host, each "Not reported by <label>" when the agent gave none.
      await p.evaluate(() => {
        const usage = [[['Tokens', '182,400 (12,000 cached)'], ['Context', '61,200 of 200,000'], ['Cost', '0.42 USD']], [['Tokens', 'Not reported by Gemini CLI'], ['Context', 'Not reported by Gemini CLI'], ['Cost', 'Not reported by Gemini CLI']]];
        document.querySelectorAll('.launch-row').forEach((row, i) => {
          for (const dt of row.querySelectorAll('dt')) if (dt.textContent.trim() === 'Host') {
            let at = dt.nextElementSibling;
            for (const [k, v] of usage[i] ?? []) { const ndt = dt.cloneNode(); ndt.textContent = k; const ndd = at.cloneNode(); ndd.textContent = v; at.after(ndt, ndd); at = ndd; }
          }
        });
      });
    });
  }
  await shot('coding-agents-registry-down', 1440, 'light', async (p) => { await open(p, 'roadmap'); await settingsScene(p, CODING_AGENTS_DOWN); });
  await b.close();
})();
