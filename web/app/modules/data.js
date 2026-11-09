// Data and audit: export, import and reset this device's data; view and verify the audit trail.
import { h, fmtTime } from './ui.js';
import { roleById } from '../core/model.js';
import { loadSyntheticHospital, currentHour, HOSPITAL_NAME } from '../core/generator.js';

const roleName = (id) => (id === 'system' ? 'System' : roleById(id)?.name || id);
// Who acted, in words (issue #17): a person in a role, an agent for a role, or the system.
export function actorLabel(e) {
  const type = e.actorType || (e.actorRole === 'system' ? 'system' : 'human');
  if (type === 'agent') return `Agent ${e.agent} for ${roleName(e.actorRole)}`;
  if (type === 'system' || e.actorRole === 'system') return 'System';
  return `Person · ${roleName(e.actorRole)}`;
}
const actorTypeOf = (e) => e.actorType || (e.actorRole === 'system' ? 'system' : 'human');

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function render(el, ctx) {
  const { core } = ctx;
  const status = h('p', { class: 'meta', 'data-test': 'import-status', role: 'status' });
  const chain = h('span', { class: 'pill', 'data-test': 'audit-status' }, 'Checking…');
  const tbody = h('tbody');
  const actorFilter = h('select', { id: 'audit-actor', 'data-test': 'audit-actor' },
    [['all', 'Everyone'], ['human', 'People'], ['agent', 'Agents'], ['system', 'System']].map(([v, t]) => new Option(t, v)));
  actorFilter.addEventListener('change', () => refresh());

  async function refresh() {
    const log = await core.auditLog();
    const res = await core.verifyAudit();
    chain.className = `pill ${res.ok ? 'pill-ok' : 'pill-bad'}`;
    chain.textContent = res.ok ? `Intact: ${log.length} entries` : `Broken at entry ${res.at}`;
    const want = actorFilter.value;
    const recent = log.filter((e) => want === 'all' || actorTypeOf(e) === want).slice(-50).reverse();
    tbody.replaceChildren(...(recent.length ? recent.map((e) => h('tr', {},
      h('td', {}, e.seq),
      h('td', {}, fmtTime(e.at)),
      h('td', { 'data-actor-type': actorTypeOf(e) }, actorLabel(e)),
      h('td', {}, e.action, e.target ? ` · ${e.target}` : ''),
      h('td', {}, h('code', { title: e.hash }, e.hash.slice(0, 12))))) : [h('tr', {}, h('td', { colspan: 5 }, want === 'all' ? 'No entries yet.' : 'No entries by this kind of actor.'))]));
  }

  const file = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', class: 'sr-only' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const errs = await core.validateImport(data);
      if (errs.length) { status.textContent = `Import refused. Nothing was changed. ${errs[0]}`; return; }
      if (!confirm(`Replace all data on this device with ${data.entities.length} records and ${data.events.length} events from this file?`)) return;
      const res = await core.importData(data, ctx.role);
      status.textContent = `Imported ${res.entities} records and ${res.events} events.`;
      ctx.toast('Import complete');
      await refresh();
    } catch (err) {
      status.textContent = `Import refused. Nothing was changed. ${err.message}`;
    }
  });

  const exportBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    // Record the export first, so the file carries its own audit entry.
    const [entities, events] = await Promise.all([core.listEntities(), core.events()]);
    await core.record(ctx.role, 'data.exported', null, { entities: entities.length, events: events.length });
    const data = await core.exportData();
    download(`ospeli-export-${data.exportedAt.slice(0, 10)}.json`, JSON.stringify(data, null, 2));
    ctx.toast('Export downloaded');
    await refresh();
  } }, 'Export JSON');

  const resetBtn = h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
    if (!confirm('Delete all Ospeli data on this device? Export first if you want to keep it.')) return;
    await core.reset();
    await core.record(ctx.role, 'data.reset');
    genLine?.remove(); // nothing is loaded now (issue #7)
    ctx.toast('Device data cleared');
    await refresh();
  } }, 'Reset device data');

  const gen = await core.getMeta('generator');
  const genLine = gen ? h('p', { class: 'meta', 'data-test': 'generator-meta' }, `Seed ${gen.seed}, data up to ${fmtTime(gen.end)}.`) : null;
  const reloadBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
    if (!confirm(`Replace all data on this device with a fresh ${HOSPITAL_NAME}? Export first if you want to keep it.`)) return;
    reloadBtn.disabled = true;
    await core.reset();
    const res = await loadSyntheticHospital(core, { end: currentHour() });
    await core.record(ctx.role, 'data.synthetic-loaded', null, { seed: res.meta.seed, end: res.meta.end });
    ctx.toast(`${HOSPITAL_NAME} loaded`);
    location.reload();
  } }, 'Load a fresh copy');

  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Data and audit'),
        h('h1', {}, 'Your data stays on this device'),
        h('p', {}, ctx.storage === 'indexeddb'
          ? 'Everything is saved in this browser and works offline. Export a copy to move it or keep a backup.'
          : 'This browser is blocking storage, so changes will be lost when you close the page.'))),
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('h2', {}, 'Export'),
        h('p', {}, 'Download everything as one JSON file: the hospital model, the event log and the audit trail.'),
        h('div', { class: 'actions' }, exportBtn)),
      h('div', { class: 'card' },
        h('h2', {}, 'Import'),
        h('p', {}, 'Load an Ospeli export file. It is checked first, including the audit trail; a bad file changes nothing.'),
        h('div', { class: 'actions' }, h('label', { class: 'btn btn-ghost', for: 'import-file' }, 'Choose file…'), file),
        status),
      h('div', { class: 'card' },
        h('h2', {}, HOSPITAL_NAME),
        h('p', {}, 'A fictional hospital with 6 wards, 120 beds and 30 days of generated activity. Every name and number is synthetic.'),
        genLine,
        h('div', { class: 'actions' }, reloadBtn)),
      h('div', { class: 'card' },
        h('h2', {}, 'Reset'),
        h('p', {}, 'Clear all data on this device. This cannot be undone.'),
        h('div', { class: 'actions' }, resetBtn))),
    h('section', { class: 'section', 'aria-labelledby': 'audit-h' },
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', { id: 'audit-h' }, 'Audit trail'),
          h('p', {}, 'Every change is recorded by role, never by person, and says whether a person or an agent acted. Each entry is linked to the one before, so edits show up.')),
        chain),
      h('div', { class: 'audit-filter' }, h('label', { for: 'audit-actor' }, 'Show'), actorFilter),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Audit trail, scroll sideways' },
        h('table', {},
          h('caption', { class: 'sr-only' }, 'Most recent 50 audit entries'),
          h('thead', {}, h('tr', {}, ['#', 'When', 'Actor', 'Action', 'Hash'].map((t) => h('th', { scope: 'col' }, t)))),
          tbody))),
  );
  await refresh();
}
