// Issue #101: an example an agent copies from commands.json either runs as written on a fresh
// example hospital, or says what it needs first (example.needs). And what it says it needs is
// true: with that in place, the same example runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, listCommands, CommandError, ACTION_COMMANDS } from '../../web/app/core/commands.js';
import { MODULE_PACKS } from '../../web/app/core/modules.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });

// A fresh example hospital. A person has switched agents on for every ward and listed one agent
// for the role: nothing else is prepared.
async function freshSite(role) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'example-runner', role, wards, days: 30 }, human('coo'));
  return core;
}
// The caller the example is written for: an agent where agents may call, a person otherwise.
const callerFor = (c, role = c.roles[0]) => (c.agentsMayCall ? { type: 'agent', agent: 'example-runner', role } : human(role));

test('every published example runs as written on a fresh example hospital, or says what it needs (issue #101)', async () => {
  const refused = [];
  let ran = 0;
  for (const c of listCommands()) {
    const core = await freshSite(c.roles[0]);
    try {
      await runCommand(core, c.name, structuredClone(c.example.input), callerFor(c));
      ran += 1;
      // A bed write that happens to run still says the state it needs: the example bed moves on with the clock.
      // The clean of a bed follows the bed, so the same holds for starting and finishing a task.
      // Stock moves through the day too: a stock write that happens to run on today's example stock still says what it needs.
      if (c.example.needs) assert.ok(c.name.startsWith('ospeli_beds_') || c.name.startsWith('ospeli_stock_') || ['ospeli_tasks_start', 'ospeli_tasks_complete', 'ospeli_tasks_set_priority', 'ospeli_tasks_release'].includes(c.name), `${c.name}: the example runs as written, so it should not say it needs anything`);
    } catch (err) {
      assert.ok(err instanceof CommandError, `${c.name}: ${err.stack}`);
      if (typeof c.example.needs !== 'string' || c.example.needs.length < 30) refused.push(`${c.name}: ${err.code} (${err.message.slice(0, 60)})`);
      else assert.ok(['conflict', 'not-found'].includes(err.code), `${c.name}: an example that needs something is refused for the state of its target, not as ${err.code}`);
    }
  }
  assert.deepEqual(refused, [], 'examples refused on a fresh site with no "needs" line');
  // Each example gets its own fresh site, so nothing an earlier example made helps a later one.
  assert.ok(ran >= 22, `${ran} examples run as written`);
});

// Bring one occupied bed to the state an example needs, the way people would on screen.
const BED_PATH = {
  occupied: [],
  'expected-discharge': ['expect-discharge'],
  vacated: ['vacate'],
  cleaning: ['vacate', 'start-clean'],
  available: ['vacate', 'finish-clean'],
  allocated: ['vacate', 'finish-clean', 'allocate'],
  'out-of-service': ['vacate', 'finish-clean', 'out-of-service'],
};
async function bedIn(core, state) {
  const board = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
  const bed = board.beds.find((b) => b.state === 'occupied');
  const waiting = board.waiting.find((w) => !w.allocatedBed);
  for (const action of BED_PATH[state]) {
    const extra = action === 'allocate' ? { encounter: waiting.encounter } : action === 'out-of-service' ? { reason: 'Electrical' }
      : action === 'expect-discharge' ? { expectedAt: '2026-11-08T15:00:00.000Z' } : {};
    await runCommand(core, ACTION_COMMANDS[action], { bedId: bed.id, ...extra }, human('bed-manager'));
  }
  return { bedId: bed.id, waiting };
}

// What each "needs" line asks for, put in place by people; returns the ids to use instead of the example's.
async function prepare(core, c) {
  const { name } = c;
  if (name.startsWith('ospeli_beds_')) {
    assert.ok(Array.isArray(c.example.needsState) && c.example.needsState.length, `${name}: needsState lists the bed states the example works on`);
    for (const s of c.example.needsState) assert.ok(c.example.needs.includes(s), `${name}: the needs line names the state ${s}`);
    const { bedId, waiting } = await bedIn(core, c.example.needsState[0]);
    if (name !== 'ospeli_beds_allocate') return { bedId };
    assert.match(c.example.needs, /waiting/i, 'allocate also needs a waiting patient');
    const next = (await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'))).waiting.find((w) => !w.allocatedBed);
    return { bedId, encounter: (next || waiting).encounter };
  }
  if (name.startsWith('ospeli_workorders_')) {
    assert.match(c.example.needs, /ospeli_workorders_list/, `${name}: the needs line says where to find an open work order`);
    const open = await runCommand(core, 'ospeli_workorders_list', { state: 'open' }, human('estates-tech'));
    const wo = open.workOrders.find((w) => w.state !== 'started') || open.workOrders[0];
    return { workOrderId: wo.id };
  }
  if (name.startsWith('ospeli_maps_')) {
    assert.match(c.example.needs, /ospeli_maps_create/, `${name}: the needs line says how to start a map`);
    const made = await runCommand(core, 'ospeli_maps_create', { from: 'discharge' }, human('ops-manager'));
    const ids = { mapId: made.mapId };
    if (c.example.input.stepId) {
      const map = await runCommand(core, 'ospeli_maps_get', { mapId: made.mapId }, human('ops-manager'));
      ids.stepId = map[c.example.input.version].steps[2].id;
    }
    return ids;
  }
  if (name.startsWith('ospeli_proposals_')) {
    assert.match(c.example.needs, /ospeli_proposals_list/, `${name}: the needs line says where to find a proposal`);
    const board = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
    const bed = board.beds.find((b) => b.state === 'occupied');
    await runCommand(core, 'ospeli_agents_add', { name: 'proposer', role: 'ward-nurse', wards: [bed.wardId], days: 30 }, human('coo'));
    const p = await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, { type: 'agent', agent: 'proposer', role: 'ward-nurse' });
    return { id: p.proposal.id };
  }
  if (name.startsWith('ospeli_tasks_')) {
    assert.match(c.example.needs, /ospeli_tasks_list/, `${name}: the needs line says where to find an open task`);
    if (name === 'ospeli_tasks_cancel') {
      // A task someone asked for: the request command's own example, run by a person.
      const ask = listCommands().find((x) => x.name === 'ospeli_tasks_request');
      return { taskId: (await runCommand(core, ask.name, structuredClone(ask.example.input), human(ask.roles[0]))).taskId };
    }
    const { bedId } = await bedIn(core, name === 'ospeli_tasks_release' ? 'cleaning' : 'vacated'); // a vacated bed is a clean task
    return { taskId: `clean-${bedId}` };
  }
  if (name.startsWith('ospeli_stock_')) {
    assert.match(c.example.needs, /ospeli_stock_/, `${name}: the needs line names the stock command that finds or makes what is needed`);
    // A new item nobody has touched, so the example hospital's own stock history cannot get in the way.
    const list = await runCommand(core, 'ospeli_stock_items', {}, human('coo'));
    const exampleItem = listCommands().find((x) => x.name === 'ospeli_stock_count').example.input.lines[0].itemId;
    const cat = list.categories.find((x) => x.id === list.items.find((it) => it.id === exampleItem).category);
    const as = (verb, cmd, input) => {
      assert.ok(cat.roles[verb].length, `${name}: preparing its example needs a role that may ${verb} ${cat.id} stock`);
      return runCommand(core, `ospeli_stock_${cmd}`, input, human(cat.roles[verb][0]));
    };
    const { itemId } = await as('itemAdd', 'item_add', { name: 'Example test pack', unit: 'pack', category: cat.id });
    const one = [{ itemId, qty: 1 }];
    const stockAt = (placeId, qty) => as('receive', 'receive', { placeId, lines: [{ itemId, qty }], source: 'Purchase' });
    switch (name.slice('ospeli_stock_'.length)) {
      case 'use': case 'write_off': case 'hold': case 'transfer': await stockAt('ward-a1', 5); return { lines: one };
      case 'release': await stockAt('ward-a1', 5); await as('hold', 'hold', { placeId: 'ward-a1', lines: one, reason: 'Damaged packaging' }); return { lines: one };
      case 'request': return { lines: [{ itemId, qty: 10 }] };
      case 'issue': case 'request_cancel': {
        await stockAt(list.stores[0].id, 20);
        return { requestId: (await as('request', 'request', { placeId: 'ward-a1', lines: [{ itemId, qty: 2 }] })).requestId };
      }
      case 'out_start': case 'level_set': return { itemId };
      case 'out_end': return { stockOutId: (await as('count', 'out_start', { itemId, placeId: 'ward-a1', cause: 'Not delivered' })).stockOutId };
      default: assert.fail(`${name}: add what this stock example needs to the test`);
    }
  }
  // The shared patient code and slot objects: a person's own steps make what the example needs.
  if (name.startsWith('ospeli_codes_') || name.startsWith('ospeli_slots_')) {
    const cmd = (n) => listCommands().find((x) => x.name === n);
    const as = (n, input, role) => runCommand(core, n, input, human(role ?? cmd(n).roles[0]));
    const openCmd = cmd('ospeli_codes_open');
    assert.ok(openCmd, `${name}: its example needs a patient code, so a module must declare a kind of episode (CODE_KINDS)`);
    const kinds = (await as('ospeli_codes_kinds', {}, 'coo')).kinds;
    const openCode = async (kind = kinds[0]) => (await as('ospeli_codes_open', { kind: kind.id, service: kind.services[0].id, source: kind.sources[0], again: true }, kind.openRoles[0])).code;
    if (name.startsWith('ospeli_codes_')) {
      assert.match(c.example.needs, /ospeli_codes_|example ids/, `${name}: the needs line says where a code comes from`);
      switch (name.slice('ospeli_codes_'.length)) {
        case 'stage': {
          // Walk the kind's own order until the example's stage may follow.
          const kind = kinds.find((k) => k.stages.some((st) => st.id === c.example.input.stage));
          const code = await openCode(kind);
          const want = kind.stages.find((st) => st.id === c.example.input.stage);
          let at = kind.openStage;
          for (let hops = 0; hops < 20 && at !== want.id && !want.after.includes(at); hops++) {
            const next = kind.stages.find((st) => st.id !== at && (at == null ? !st.after.length : st.after.includes(at)));
            assert.ok(next, `${name}: no stage leads from ${at} towards ${want.id}`);
            await as('ospeli_codes_stage', { code, stage: next.id }, next.roles[0]);
            at = next.id;
          }
          return { code };
        }
        case 'due_set': { const kind = kinds.find((k) => k.dueBy); return { code: await openCode(kind), dueBy: new Date(Date.parse(core.now()) + 7 * 864e5).toISOString().slice(0, 10) }; }
        case 'link': { const kind = kinds.find((k) => k.links); return { code: await openCode(kind), otherCode: await openCode(kind) }; }
        default: return { code: await openCode() };
      }
    }
    assert.match(c.example.needs, /ospeli_slots_/, `${name}: the needs line names the slot command that finds or makes what is needed`);
    const plan = cmd('ospeli_slots_session_plan');
    // Issue #192: Arrived is marked on the session's own day only, as the step examples' needs lines
    // say, so for those the session is planned on the site's today.
    const onToday = name === 'ospeli_slots_step' || name === 'ospeli_slots_step_correct';
    const today = onToday ? (await as('ospeli_slots_sessions', { format: 'short', limit: 1 })).from : null;
    const sessionId = (await as(plan.name, { ...structuredClone(plan.example.input), ...(onToday ? { date: today } : {}) })).sessionId;
    if (name === 'ospeli_slots_appointments' || name === 'ospeli_slots_session_change') return { sessionId };
    const book = cmd('ospeli_slots_book');
    const code = await openCode();
    if (name === 'ospeli_slots_book') return { sessionId, code };
    const appointmentId = (await as(book.name, { ...structuredClone(book.example.input), sessionId, code })).appointmentId;
    if (name === 'ospeli_slots_step_correct') await as('ospeli_slots_step', { appointmentId, step: c.example.input.undo });
    return name === 'ospeli_slots_move' ? { appointmentId, sessionId } : { appointmentId };
  }
  // A module's own commands: the module says how to put in place what its example needs.
  const pack = MODULE_PACKS.find((p) => name.startsWith(p.PREFIX));
  if (pack) {
    assert.equal(typeof pack.prepareExample, 'function', `${name}: module ${pack.id} must export prepareExample(core, command, tools) for examples that need something`);
    return (await pack.prepareExample(core, c, { run: (n, input, role) => runCommand(core, n, input, human(role)) })) || {};
  }
  if (name === 'ospeli_agents_remove') {
    assert.match(c.example.needs, /ospeli_agents_add/, `${name}: the needs line says how an agent gets on the list`);
    await runCommand(core, 'ospeli_agents_add', { name: c.example.input.name, role: 'bed-manager', wards: [], days: 30 }, human('coo'));
    return {};
  }
  if (name.startsWith('ospeli_walks_')) {
    assert.match(c.example.needs, /ospeli_walks_start/, `${name}: the needs line says how a walk starts`);
    // The taps a person makes before this one.
    const before = { ospeli_walks_step_start: [], ospeli_walks_rename: [], ospeli_walks_discard: [], ospeli_walks_step_done: ['step_start'], ospeli_walks_undo: ['step_start'], ospeli_walks_reason: ['step_start'], ospeli_walks_pause: [], ospeli_walks_resume: ['pause'],
      ospeli_walks_step_name: ['step_start', 'step_done'], ospeli_walks_finish: ['step_start', 'step_done'] }[name];
    // A list step can only be marked "did not happen" on a repeat walk: walk one step, finish, walk that map again.
    if (name === 'ospeli_walks_step_skip') {
      const me = human(c.roles[0]);
      await runCommand(core, 'ospeli_walks_start', {}, me);
      for (const tap of ['step_start', 'step_done']) await runCommand(core, `ospeli_walks_${tap}`, {}, me);
      const { mapId } = await runCommand(core, 'ospeli_walks_finish', {}, me);
      await runCommand(core, 'ospeli_walks_start', { mapId }, me);
      return {};
    }
    assert.ok(before, `${name}: add the taps this example needs to the test`);
    await runCommand(core, 'ospeli_walks_start', {}, human(c.roles[0]));
    for (const tap of before) await runCommand(core, `ospeli_walks_${tap}`, {}, human(c.roles[0]));
    return {};
  }
  assert.fail(`${name}: this test does not know how to put "${c.example.needs}" in place; add it`);
  return {};
}

test('what an example says it needs is true: with that in place it runs (issue #101)', async () => {
  const needing = listCommands().filter((c) => c.example.needs);
  assert.ok(needing.length >= 1, 'some examples say what they need');
  for (const c of needing) {
    const role = c.name.startsWith('ospeli_proposals_') ? 'ward-nurse' : c.roles[0];
    const core = await freshSite(role);
    const ids = await prepare(core, c);
    const input = { ...structuredClone(c.example.input), ...ids };
    try {
      const out = await runCommand(core, c.name, input, callerFor(c, role));
      assert.ok(out && typeof out === 'object', c.name);
      // Issue #95: an answer coming back is not enough. A write an agent calls only queues a proposal,
      // so a person of that role says yes and the change must then run ("accepted", not "expired").
      if (out.status === 'proposed') {
        const yes = await runCommand(core, 'ospeli_proposals_accept', { id: out.proposal.id }, human(role));
        assert.equal(yes.status, 'accepted', `${c.name}: with "${c.example.needs}" in place the queued example does not run when a person says yes: ${yes.message || yes.status}`);
      } else if (out.status !== undefined) {
        assert.ok(['done', 'accepted', 'declined'].includes(out.status), `${c.name}: the example ran to "${out.status}"`);
      } else {
        assert.ok(Object.keys(out).length > 0, `${c.name}: an empty answer`);
      }
    } catch (err) {
      assert.fail(`${c.name}: with "${c.example.needs}" in place the example is still refused: ${err.code || ''} ${err.message}`);
    }
  }
});
