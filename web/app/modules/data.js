// Data and audit: export, import and reset this device's data; view and verify the audit trail.
import { h, fmtTime } from './ui.js';
import { roleById, currentWords } from '../core/model.js';
import { loadSyntheticHospital, currentHour, HOSPITAL_NAME } from '../core/generator.js';
import { commandByName } from '../core/commands.js';
import { KPIS } from '../core/kpi.js';
import { SELF_CHECK_CASES } from '../core/audit.js';

const roleName = (id) => (id === 'system' ? 'System' : roleById(id)?.name || id);
// Who acted, in words (issue #17): a person in a role, an agent for a role, or the system.
export function actorLabel(e) {
  const type = e.actorType || (e.actorRole === 'system' ? 'system' : 'human');
  if (type === 'agent') return `Agent ${e.agent} for ${roleName(e.actorRole)}`;
  if (type === 'system' || e.actorRole === 'system') return 'System';
  // On a site server: where the person acted (issue A8). Not a named sign-in.
  const door = e.via === 'app' && e.device ? ` (on ${e.device})` : e.via === 'console' ? ' (at the server)' : '';
  return `Person · ${roleName(e.actorRole)}${door}`;
}
const actorTypeOf = (e) => e.actorType || (e.actorRole === 'system' ? 'system' : 'human');

// Reset, a fresh copy and import also switch agents off (issue #51); say so before the person confirms.
const AGENTS_OFF_TOO = ' AI agents will also be switched off.';
// What an agent read, in words a data-protection lead can scan (issue #65).
const READ_WORDS = {
  ospeli_beds_board: 'the bed board', ospeli_beds_get: 'one bed', ospeli_beds_find_free: 'free beds and the waiting list',
  ospeli_kpi_list: 'the KPI definitions', ospeli_kpi_get: 'a KPI', ospeli_agents_access: 'the agent access settings',
  ospeli_proposals_list: 'its own proposals', ospeli_assets_list: 'the asset list', ospeli_workorders_list: 'the work-order queue',
  ospeli_maps_list: 'the list of process maps', ospeli_maps_get: 'a process map', ospeli_maps_summary: 'the numbers for a process map',
  ospeli_maps_suggest: 'the guide\'s suggestions for a process map',
};
const shortName = (n) => String(n).replace(/\s*\(.*\)$/, '');
function commandWords(name) {
  if (READ_WORDS[name]) return READ_WORDS[name];
  const cmd = commandByName(name);
  // A write command's summary is one short sentence written for a new colleague.
  if (cmd && cmd.kind === 'write') return cmd.summary.split(/(?<=[.!?])\s/)[0].replace(/[.:]$/, '');
  return String(name || 'a command').replace(/^ospeli_/, '').replace(/_/g, ' ');
}
// Where a call pointed: only ids the trail stored as real, turned into the names on screen.
// `places` maps an entity id to { name, parentId }.
function whereWords(command, input, places) {
  const out = [];
  const place = (id) => {
    if (id === '(unknown)') return 'an id that names nothing here';
    const p = places.get(id);
    if (!p) return id;
    const parent = p.type === 'bed' && places.get(p.parentId);
    return currentWords(parent ? `${shortName(parent.name)}, ${p.name}` : shortName(p.name)); // names stored before issue #82 read with today's words
  };
  for (const k of ['wardId', 'locationId', 'bedId', 'assetId']) if (typeof input?.[k] === 'string') out.push(place(input[k]));
  if (command === 'ospeli_kpi_get' && input?.id) out.push(KPIS.find((k) => k.id === input.id)?.name || input.id);
  if (typeof input?.mapId === 'string') out.push(input.mapId);
  if (input?.overdue === true) out.push('overdue only');
  if (input?.state === 'completed') out.push('completed');
  return out.join(', ');
}

// Audit actions whose detail a person needs to read in the table. The raw action id stays on the
// cell as data-action and title.
export function actionLabel(e, places = new Map()) {
  const plain = { 'data.reset': 'Device data cleared', 'data.exported': 'Data exported', 'data.imported': 'Data imported', 'data.synthetic-loaded': 'Fresh copy loaded' }[e.action];
  if (plain) return plain;
  const d = e.detail || {};
  if (e.action === 'agent.read' && d.command) {
    const where = whereWords(d.command, d.input, places);
    return `Read ${commandWords(d.command)}${where ? `: ${where}` : ''}${d.outcome ? ` (failed: ${d.outcome})` : ''}`;
  }
  if (e.action === 'agent.refused' && d.command) {
    const more = d.repeats?.count ? ` (and ${d.repeats.count} more like it just before)` : '';
    return `Refused: ${d.command === '(unknown)' ? 'a command that does not exist' : commandWords(d.command)}. ${String(d.why || d.code || '').slice(0, 200)}${more}`;
  }
  if (e.action === 'agent.proposed' && d.command) {
    const where = whereWords(d.command, d.input, places);
    return `Proposed: ${commandWords(d.command)}${where ? ` (${where})` : ''}`;
  }
  if (e.action !== 'agents.access-cleared' || !e.detail?.was) return e.action;
  const w = e.detail.was; const n = (c, word) => `${c} ${word}${c === 1 ? '' : 's'}`;
  return `Agents switched off by ${e.detail.by} (was ${w.dial === 'advise' ? 'Advise' : 'Off'}, ${n(w.wards, 'ward')}, ${n(w.agents, 'agent')})`;
}

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
  const chainNote = h('p', { class: 'audit-note', 'data-test': 'audit-note', role: 'status' });
  const tbody = h('tbody');
  const actorFilter = h('select', { id: 'audit-actor', 'data-test': 'audit-actor' },
    [['all', 'Everyone'], ['human', 'People'], ['agent', 'Agents'], ['system', 'System']].map(([v, t]) => new Option(t, v)));
  actorFilter.addEventListener('change', () => refresh());

  async function refresh() {
    const [log, entities] = await Promise.all([core.auditLog(), core.listEntities()]);
    const places = new Map(entities.map((x) => [x.id, x]));
    // The pill says what the self-check proves and no more (issue #79). Green only for a trail
    // that passed and was never replaced on this device; an empty or replaced trail stays neutral.
    const res = await core.auditCheck();
    const n = `${res.entries} ${res.entries === 1 ? 'entry' : 'entries'}`;
    const NO_COPY = 'No outside copy to compare with yet.';
    if (!res.ok) {
      chain.className = 'pill pill-bad';
      chain.textContent = `Broken at entry ${res.at}`;
      chainNote.textContent = 'The self-check found an entry that does not match its check code.';
    } else if (res.replaced) {
      chain.className = 'pill';
      chain.textContent = `History replaced on ${new Date(res.replaced.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      chainNote.textContent = `The earlier history on this device was replaced ${res.replaced.by === 'storage-cleared' ? 'after the browser cleared this device\'s storage. Nobody chose it' : res.replaced.by === 'import' ? 'by an import' : 'by a reset or a fresh copy'}. ${res.entries ? `Self-check passed on the ${n} here now. ` : ''}${NO_COPY}`;
    } else if (!res.entries) {
      chain.className = 'pill';
      chain.textContent = 'No entries yet';
      chainNote.textContent = 'Nothing to check yet.';
    } else {
      chain.className = 'pill pill-ok';
      chain.textContent = `Self-check passed: ${n}`;
      chainNote.textContent = NO_COPY;
    }
    const exported = log.filter((e) => e.action === 'data.exported').at(-1);
    if (!exported) {
      lastExport.textContent = 'This data has not been exported yet. An export is the only backup.';
      lastExport.dataset.old = 'false';
    } else {
      const days = Math.floor((Date.parse(core.now()) - Date.parse(exported.at)) / 864e5);
      const when = new Date(exported.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      lastExport.dataset.old = String(days >= NUDGE_DAYS);
      lastExport.textContent = days >= NUDGE_DAYS ? `Last export: ${when}, ${days} days ago. Export a new backup.` : `Last export: ${when}.`;
    }
    const want = actorFilter.value;
    const recent = log.filter((e) => want === 'all' || actorTypeOf(e) === want).slice(-50).reverse();
    tbody.replaceChildren(...(recent.length ? recent.map((e) => h('tr', {},
      h('td', {}, e.seq),
      h('td', {}, fmtTime(e.at)),
      h('td', { 'data-actor-type': actorTypeOf(e) }, actorLabel(e)),
      h('td', { 'data-action': e.action, title: e.action }, actionLabel(e, places), e.target ? ` · ${e.target}` : ''),
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
      const agentsOn = await core.agentAccessInUse();
      if (!confirm(`Replace all data on this device with ${data.entities.length} records and ${data.events.length} events from this file?${agentsOn ? AGENTS_OFF_TOO : ''}`)) return;
      const res = await core.importData(data, ctx.role);
      await refresh(); // the trail and its pill first, so "Imported" is never shown beside the old state
      status.textContent = `Imported ${res.entities} records and ${res.events} events.${agentsOn ? ' Agents are off.' : ''}`;
      ctx.toast(agentsOn ? 'Import complete. Agents are off.' : 'Import complete');
    } catch (err) {
      status.textContent = `Import refused. Nothing was changed. ${err.message}`;
    }
  });

  // When this data was last exported, read from the audit trail (issue #87): an export is the
  // only backup of a stand-alone device, so the page says how old it is.
  const lastExport = h('p', { class: 'last-export', 'data-test': 'last-export', 'data-old': 'false' }, '');
  const NUDGE_DAYS = 7;
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
    const agentsOn = await core.agentAccessInUse();
    if (!confirm(`Delete all Ospeli data on this device?${agentsOn ? AGENTS_OFF_TOO : ''} Export first if you want to keep your data.`)) return;
    await core.reset(ctx.role);
    await core.record(ctx.role, 'data.reset');
    genLine?.remove(); // nothing is loaded now (issue #7)
    ctx.toast(agentsOn ? 'Device data cleared. Agents are off.' : 'Device data cleared');
    await refresh();
  } }, 'Reset device data');

  const gen = await core.getMeta('generator');
  const genLine = gen ? h('p', { class: 'meta', 'data-test': 'generator-meta' }, `Seed ${gen.seed}, data up to ${fmtTime(gen.end)}.`) : null;
  const reloadBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
    const agentsOn = await core.agentAccessInUse();
    if (!confirm(`Replace all data on this device with a fresh ${HOSPITAL_NAME}?${agentsOn ? AGENTS_OFF_TOO : ''} Export first if you want to keep your data.`)) return;
    reloadBtn.disabled = true;
    await core.reset(ctx.role);
    const res = await loadSyntheticHospital(core, { end: currentHour() });
    await core.record(ctx.role, 'data.synthetic-loaded', null, { seed: res.meta.seed, end: res.meta.end });
    ctx.toast(`${HOSPITAL_NAME} loaded`);
    location.reload();
  } }, 'Load a fresh copy');

  // A device connected to its site's server keeps a copy it cannot change: export, import and
  // reset belong to the server, so they are not offered here.
  const onSite = ctx.storage === 'site';
  if (onSite) {
    el.append(
      h('div', { class: 'page-head' },
        h('div', {},
          h('p', { class: 'eyebrow' }, 'Data and audit'),
          h('h1', {}, 'Your data stays on your site'),
          h('p', {}, 'This device shows the information kept on your site\'s own computer. Every change you make is saved there. With no connection you see the last information this device had, and changes are refused.'))),
      h('div', { class: 'card', 'data-test': 'site-device-card' },
        h('h2', {}, 'This device'),
        h('p', {}, `${ctx.device.label} · ${roleName(ctx.role)}. What is done here is recorded as a person in this role, from this device. It is not a personal sign-in.`),
        h('p', { class: 'meta' }, 'Backups, and disconnecting this device, are done at the computer that runs Ospeli.')));
  }
  if (!onSite) el.append(
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
        h('div', { class: 'actions' }, exportBtn),
        lastExport),
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
        h('div', { class: 'actions' }, resetBtn))));
  el.append(
    h('section', { class: 'section', 'aria-labelledby': 'audit-h' },
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', { id: 'audit-h' }, 'Audit trail'),
          h('p', {}, 'Role changes, data actions and agent activity are recorded here by role, never by person, and agent activity is marked as an agent\u2019s. Bed and work-order changes are kept in the event log. Each entry carries a check code from the one before, which catches accidental damage. It does not yet show whether history was rewritten or shortened on purpose.')),
        h('div', { class: 'audit-check' }, chain, chainNote)),
      h('details', { class: 'audit-what', 'data-test': 'audit-what' },
        h('summary', {}, 'What does this check?'),
        h('p', {}, 'The self-check re-works every check code on this device. There is no secret key and no copy kept anywhere else yet, so this is what it catches:'),
        h('ul', {}, SELF_CHECK_CASES.map((c) => h('li', {}, `${c.change}: `, h('b', {}, c.caught ? 'Caught' : 'Not caught')))),
        h('p', {}, 'A checkpoint kept off the device, so that a rewritten history shows up, is in development.')),
      h('div', { class: 'audit-filter' }, h('label', { for: 'audit-actor' }, 'Show'), actorFilter),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Audit trail, scroll sideways' },
        h('table', {},
          h('caption', { class: 'sr-only' }, 'Most recent 50 audit entries'),
          h('thead', {}, h('tr', {}, ['#', 'When', 'Actor', 'Action', 'Hash'].map((t) => h('th', { scope: 'col' }, t)))),
          tbody))),
  );
  await refresh();
}
