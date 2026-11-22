// Diagnostics (module diagnostics, area A5, slice 1): its commands without the screen, every
// refusal, agent proposals, attack tests, the guide switch and the example hospital's history.
// KPIs and guide rules by hand: diagnostics-kpis.test.mjs. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { deriveRequests, deriveEquipment, labTurnaround, rejectionRate } from '../../web/app/modules/diagnostics/logic.js';

const END = '2026-11-19T14:00:00.000Z'; // 10:00 on the example site's clock
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'dx-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const newRequest = async (run, extra = {}, who = 'unit-clerk') => (await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', again: true, ...extra }, who)).requestId;

test('the example hospital: thirty days of lab requests, one not arrived, a recollection linked, measures with sources, and the guide on', async () => {
  const { run, core } = await site();
  const ov = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  out('ospeli_diagnostics_overview', ov);
  const [tat, rej, av] = ov.kpis;
  assert.deepEqual([tat.value, tat.median], [null, null], 'no blended headline');
  assert.ok(tat.byGroup.length >= 4 && tat.byGroup.every((g) => g.urgent.n + g.routine.n > 0), 'urgent and routine apart, by test group, each with n');
  assert.ok(tat.byGroup.find((g) => g.testGroup === 'culture')?.note === 'first report, not final');
  assert.ok(tat.blended.n > 50 && tat.blended.median > 0 && /not comparable between weeks/.test(tat.blended.label));
  assert.equal(tat.blended.n, tat.byGroup.filter((g) => g.testGroup !== 'culture').reduce((n, g) => n + g.urgent.n + g.routine.n, 0), 'the labelled blend leaves out blood culture');
  assert.match(tat.definition, /no headline figure/);
  assert.ok(rej.denominator > 50 && rej.numerator > 0 && rej.byReason.length && rej.byArea.length);
  assert.equal(rej.byArea[0].sourceId, 'ward-a3', 'haemolysed specimens concentrated from Ward A3');
  assert.equal(av.byAsset.length, 2);
  assert.match(tat.source, /PMID 18392122/);
  assert.match(rej.source, /PMID 25719322/);
  assert.match(av.source, /D-12/);
  assert.deepEqual(ov.planned.map((p) => [p.id, p.value]), [['request-to-report', undefined], ['reporting-backlog', undefined]], 'planned measures carry no value');
  assert.ok(ov.completeness.value > 50 && ov.completeness.value < 100 && ov.completeness.missing.noCollection > 0, 'data completeness beside the measures, with requests missing a collection');
  assert.ok(ov.guide.on);
  assert.ok(ov.guide.suggestions.some((s) => s.rule === 'not-arrived' && s.sourceId === 'ward-b1'), 'the specimen collected four hours ago from Ward B1 is flagged');
  assert.ok(ov.guide.suggestions.some((s) => s.rule === 'rejection-review' && s.sourceId === 'ward-a3' && /Haemolysed/.test(s.text)));
  assert.match(ov.note, /does not interpret results/);
  const reqs = deriveRequests(await core.events());
  assert.ok([...reqs.values()].some((r) => r.recollectionOf && reqs.get(r.recollectionOf)?.state === 'rejected'), 'a recollection linked to its rejected request');
  assert.ok([...reqs.values()].some((r) => r.rejectedAfterReceipt), 'some specimens rejected after receipt');
  const log = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  out('ospeli_diagnostics_specimen_log', log);
  assert.ok(log.counts.noCollectionToday >= 1, 'received today with no collection time');
  assert.ok(log.notArrived.length >= 1 && log.notArrived[0].sourceId === 'ward-b1');
  assert.ok(log.counts.onTheWay >= log.notArrived.length);
  // The history writes only the module's own events, the role and never a person.
  for (const e of (await core.events()).filter((x) => x.type.startsWith('diagnostics.'))) {
    assert.deepEqual(Object.keys(e.data || {}).filter((k) => /name|staff|person|phone|email|address|dob|birth/i.test(k)), [], e.type);
  }
  const eq = await run('ospeli_diagnostics_equipment_list', {}, 'ward-nurse');
  out('ospeli_diagnostics_equipment_list', eq);
  assert.deepEqual(eq.equipment.map((x) => [x.assetId, x.state]).sort(), [['asset-analyser-1', 'up'], ['asset-xray-1', 'up']]);
  assert.equal(eq.faultNote, 'To report a fault, ask a facilities technician or the operations manager.');
});

test('the synthetic history is repeatable and has one analyser down episode', () => {
  const a = generateHospital({ end: END }).events.filter((e) => e.type.startsWith('diagnostics.'));
  const b = generateHospital({ end: END }).events.filter((e) => e.type.startsWith('diagnostics.'));
  assert.deepEqual(a, b);
  const eq = deriveEquipment(a).get('asset-analyser-1');
  assert.equal(eq.episodes.length, 1);
  assert.ok(eq.episodes[0].to, 'back before the end');
});

test('the lab path: a unit clerk records a request for a patient on the ward and marks it collected; the lab receives it; a scientist releases the result; turnaround counts it', async () => {
  const { run, advance, core } = await site();
  const list0 = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, 'unit-clerk');
  out('ospeli_diagnostics_requests_list', list0);
  const patient = list0.picks.patients[0];
  assert.match(patient.label, /^Patient \d+$/);
  const made = await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'urgent', encounter: patient.encounter }, 'unit-clerk');
  out('ospeli_diagnostics_request_record', made);
  assert.equal(made.code, patient.label);
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'urgent', encounter: patient.encounter }, 'ward-nurse'), (e) => e.code === 'conflict' && e.detail.already && e.detail.existing === made.requestId, 'a double tap saves nothing');
  const c = await run('ospeli_diagnostics_specimen_collect', { requestId: made.requestId, minutesAgo: 30 }, 'ward-nurse');
  out('ospeli_diagnostics_specimen_collect', c);
  assert.equal(c.collectedAt, new Date(Date.parse(END) - 30 * MIN).toISOString(), 'the time it was taken, 30 minutes back');
  await assert.rejects(run('ospeli_diagnostics_specimen_collect', { requestId: made.requestId }, 'unit-clerk'), (e) => e.code === 'conflict' && e.detail.already);
  const row = (await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, 'unit-clerk')).requests.find((r) => r.id === made.requestId);
  assert.deepEqual([row.state, row.stage, row.enteredLate, row.minutesSinceCollection], ['collected', 'Collected, on the way', true, 30], 'recorded 30 minutes after it was taken: entered late');
  const log = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  const block = log.onTheWay.find((b) => b.sourceId === 'ward-a2');
  assert.equal(block.items[0].id, made.requestId, 'urgent first in its block');
  // The measures over a fixed window (the overview's window moves with the clock).
  const win = { since: '2026-11-18T00:00:00.000Z', until: '2026-11-20T00:00:00.000Z' };
  const measures = async () => { const r = deriveRequests(await core.events()); return [labTurnaround(r, win), rejectionRate(r, win)]; };
  const before = await measures();
  advance(5);
  const rec = await run('ospeli_diagnostics_specimen_receive', { requestId: made.requestId, outcome: 'received' }, 'lab-reception');
  out('ospeli_diagnostics_specimen_receive', rec);
  assert.deepEqual([rec.status, rec.noCollectionTime, rec.clock], ['done', false, '10:05']);
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: made.requestId, outcome: 'received' }, 'lab-reception'), (e) => e.code === 'conflict' && e.detail.already, 'received twice: already saved');
  advance(42);
  const res = await run('ospeli_diagnostics_result_record', { requestId: made.requestId }, 'lab-scientist');
  out('ospeli_diagnostics_result_record', res);
  assert.equal(res.turnaroundMinutes, 42, 'received to released, not collected or requested to released');
  await assert.rejects(run('ospeli_diagnostics_result_record', { requestId: made.requestId }, 'lab-scientist'), (e) => e.code === 'conflict' && e.detail.already);
  const after = await measures();
  assert.equal(after[0].n, before[0].n + 1, 'turnaround counts one more result');
  assert.equal(after[1].denominator, before[1].denominator + 1, 'one more specimen reached the lab');
  assert.equal(after[1].numerator, before[1].numerator);
});

test('rejection: at the hatch with a picked reason; final; a recollection is a new linked request; a scientist may reject after receipt, the reception officer may not', async () => {
  const { run, advance } = await site();
  const a = await newRequest(run);
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'rejected' }, 'lab-reception'), code('invalid-input'), 'a rejection needs a reason');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received', reason: 'clotted' }, 'lab-reception'), code('invalid-input'), 'a receipt takes no reason');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'rejected', reason: 'looked bad' }, 'lab-reception'), code('invalid-input'), 'reasons are picked');
  const rj = await run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'rejected', reason: 'haemolysed' }, 'lab-reception');
  assert.equal(rj.noCollectionTime, true, 'rejected at the hatch with no collection recorded');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception'), (e) => e.code === 'conflict' && /final/.test(e.message), 'received after rejected is refused, with what to do');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'rejected', reason: 'clotted' }, 'lab-reception'), (e) => e.code === 'conflict' && e.detail.already);
  await assert.rejects(run('ospeli_diagnostics_result_record', { requestId: a }, 'lab-scientist'), code('conflict'));
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'blood-count', urgency: 'routine', recollectionOf: a }, 'unit-clerk'), code('invalid-input'), 'a recollection is for the same test group');
  const b = (await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', recollectionOf: a }, 'unit-clerk')).requestId;
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', recollectionOf: a, again: true }, 'unit-clerk'), (e) => e.code === 'conflict' && e.detail.existing === b, 'one recollection per rejected request');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', recollectionOf: b, again: true }, 'unit-clerk'), code('conflict'), 'only a rejected request is recollected');
  const list = (await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, 'unit-clerk')).requests;
  assert.deepEqual([list.find((r) => r.id === a).recollectedBy, list.find((r) => r.id === b).recollectionOf], [b, a], 'the tracker shows the two linked');
  assert.equal(list.find((r) => r.id === a).rejectReasonName, 'Haemolysed (hemolyzed)');
  // After receipt: only a laboratory scientist rejects.
  advance(1);
  const c = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: c, outcome: 'received' }, 'lab-reception');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: c, outcome: 'rejected', reason: 'clotted' }, 'lab-reception'), (e) => e.code === 'forbidden' && /lab-scientist/.test(e.message));
  await run('ospeli_diagnostics_specimen_receive', { requestId: c, outcome: 'rejected', reason: 'clotted' }, 'lab-scientist');
  const ov = await run('ospeli_diagnostics_requests_list', { stage: 'rejected', find: c.replace(/^dx-0*/, '') }, 'diagnostics-manager');
  assert.deepEqual([ov.requests[0].state, ov.requests[0].rejectedAfterReceipt], ['rejected', true]);
});

test('undo: a receipt or rejection tapped by mistake, for a few minutes only; never once recollected; people only', async () => {
  const { run, advance } = await site();
  const a = await newRequest(run);
  await run('ospeli_diagnostics_specimen_collect', { requestId: a }, 'unit-clerk');
  await run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception');
  const u = await run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'tapped-by-mistake' }, 'lab-reception');
  out('ospeli_diagnostics_specimen_undo', u);
  assert.equal(u.state, 'collected', 'back on the way');
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'tapped-by-mistake' }, 'lab-reception'), code('conflict'), 'nothing left to undo');
  await run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception');
  advance(6);
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'wrong-request' }, 'lab-reception'), (e) => e.code === 'conflict' && /5 minutes/.test(e.message));
  const b = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: b, outcome: 'rejected', reason: 'unlabelled' }, 'lab-reception');
  await newRequest(run, { recollectionOf: b });
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: b, reason: 'tapped-by-mistake' }, 'lab-reception'), code('conflict'), 'a rejection with a recollection stays');
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: b, reason: 'tapped-by-mistake' }, 'unit-clerk'), code('forbidden'));
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: b, reason: 'tapped-by-mistake' }, agent('lab-reception')), (e) => ['agents-off', 'forbidden'].includes(e.code), 'people only');
});

test('cancel: before the lab only, with a picked reason; left out of every measure', async () => {
  const { run } = await site();
  const a = await newRequest(run);
  await assert.rejects(run('ospeli_diagnostics_request_cancel', { requestId: a }, 'unit-clerk'), code('invalid-input'));
  const c = await run('ospeli_diagnostics_request_cancel', { requestId: a, reason: 'not-needed' }, 'diagnostics-manager');
  out('ospeli_diagnostics_request_cancel', c);
  await assert.rejects(run('ospeli_diagnostics_request_cancel', { requestId: a, reason: 'not-needed' }, 'unit-clerk'), (e) => e.code === 'conflict' && e.detail.already);
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception'), code('conflict'));
  const b = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: b, outcome: 'received' }, 'lab-reception');
  await assert.rejects(run('ospeli_diagnostics_request_cancel', { requestId: b, reason: 'not-needed' }, 'unit-clerk'), code('conflict'), 'already at the lab');
});

test('who may do what: a role outside each command\'s list is refused', async () => {
  const { run } = await site();
  const a = await newRequest(run);
  const tries = [
    ['ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' }, ['lab-scientist', 'radiographer', 'diagnostics-manager', 'coo']],
    ['ospeli_diagnostics_specimen_collect', { requestId: a }, ['lab-reception', 'lab-scientist', 'diagnostics-manager']],
    ['ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, ['unit-clerk', 'ward-nurse', 'diagnostics-manager', 'radiographer']],
    ['ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'tapped-by-mistake' }, ['unit-clerk', 'diagnostics-manager']],
    ['ospeli_diagnostics_result_record', { requestId: a }, ['lab-reception', 'diagnostics-manager']],
    ['ospeli_diagnostics_request_cancel', { requestId: a, reason: 'not-needed' }, ['lab-scientist', 'radiographer', 'coo']],
    ['ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'hold' }, ['lab-reception', 'unit-clerk', 'ops-manager']],
    ['ospeli_diagnostics_guide_set', { on: false }, ['lab-scientist', 'ops-manager', 'coo']],
  ];
  for (const [name, input, roles] of tries) {
    for (const role of roles) await assert.rejects(run(name, input, role), code('forbidden'), `${role} cannot run ${name}`);
  }
  // Each kind of equipment has its own people.
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'hold' }, 'radiographer'), code('forbidden'));
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-xray-1', state: 'down', reason: 'breakdown', backup: 'other-room' }, 'lab-scientist'), code('forbidden'));
  // Reads are open to every role.
  for (const name of ['ospeli_diagnostics_requests_list', 'ospeli_diagnostics_specimen_log', 'ospeli_diagnostics_equipment_list', 'ospeli_diagnostics_overview']) assert.ok(await run(name, {}, 'coo'));
});

test('attacks: made-up ids are not echoed, unknown fields and typed text are refused, ids are checked for shape and type', async () => {
  const { run } = await site();
  const noEcho = (needle) => (e) => e instanceof CommandError && ['not-found', 'invalid-input'].includes(e.code) && !e.message.includes(needle);
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: 'dx-77777', outcome: 'received' }, 'lab-reception'), noEcho('77777'));
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-made-up', testGroup: 'chemistry', urgency: 'routine' }, 'unit-clerk'), noEcho('made-up'));
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', encounter: 'enc-999999' }, 'unit-clerk'), noEcho('999999'), 'an encounter that is not on this site');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a1-bed-01', testGroup: 'chemistry', urgency: 'routine' }, 'unit-clerk'), code('not-found'), 'a bed is not a source');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'dept-laboratory', testGroup: 'chemistry', urgency: 'routine' }, 'unit-clerk'), code('not-found'), 'the lab does not ask itself');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', note: 'For Dr Jane Smith, phone 0123 456789' }, 'unit-clerk'), code('invalid-input'), 'no typed note at all');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'stat' }, 'unit-clerk'), code('invalid-input'), 'urgency is picked');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'potassium', urgency: 'routine' }, 'unit-clerk'), code('invalid-input'), 'no choice of test: a test group from the list');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: '<img src=x onerror=alert(1)>', testGroup: 'chemistry', urgency: 'routine' }, 'unit-clerk'), code('invalid-input'));
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', encounter: 'John Smith' }, 'unit-clerk'), code('invalid-input'), 'an encounter is an id, never a name');
  await assert.rejects(run('ospeli_diagnostics_specimen_collect', { requestId: 'dx-00001; drop', minutesAgo: 5 }, 'unit-clerk'), code('invalid-input'));
  await assert.rejects(run('ospeli_diagnostics_specimen_collect', { requestId: 'dx-00001', minutesAgo: -30 }, 'unit-clerk'), code('invalid-input'), 'never in the future');
  await assert.rejects(run('ospeli_diagnostics_specimen_collect', { requestId: 'dx-00001', minutesAgo: 240 }, 'unit-clerk'), code('invalid-input'), 'a few minutes back only');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-generator-1', state: 'down', reason: 'breakdown', backup: 'hold' }, 'diagnostics-manager'), code('not-found'), 'not an analyser or scanner');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'hold', workOrderId: 'wo-99999' }, 'diagnostics-manager'), noEcho('99999'), 'a made-up work order');
  await assert.rejects(run('ospeli_diagnostics_overview', { days: 400 }, 'coo'), code('invalid-input'));
  await assert.rejects(run('ospeli_diagnostics_requests_list', { find: 'Smith' }, 'coo'), code('invalid-input'), 'find takes digits only');
});

test('equipment: down with a reason, backup route and the open work order (read-only); partly down needs some test groups; back; every ward with open requests sees it; availability counts it', async () => {
  const { run, advance } = await site();
  const wo = await run('ospeli_workorders_report_fault', { assetId: 'asset-analyser-1', fault: 'Analyser calibration error', priority: 'high' }, 'ops-manager');
  const list = await run('ospeli_diagnostics_equipment_list', {}, 'lab-scientist');
  const an = list.equipment.find((x) => x.assetId === 'asset-analyser-1');
  assert.deepEqual(an.openWorkOrders.map((w) => w.id), [wo.workOrderId]);
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', backup: 'hold' }, 'lab-scientist'), code('invalid-input'), 'needs a reason');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown' }, 'lab-scientist'), code('invalid-input'), 'needs a backup route');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'mobile-unit' }, 'lab-scientist'), code('invalid-input'), 'a scanner\'s backup is not an analyser\'s');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'partly-down', reason: 'no-reagent', backup: 'hold' }, 'lab-scientist'), code('invalid-input'), 'partly down names what it cannot run');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'partly-down', reason: 'no-reagent', backup: 'hold', testGroups: ['chemistry', 'urine'] }, 'lab-scientist'), code('invalid-input'), 'all of them is down, not partly');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'up' }, 'lab-scientist'), (e) => e.code === 'conflict' && e.detail.already);
  // Open chemistry requests on two wards.
  const a2 = await newRequest(run, { sourceId: 'ward-a2' });
  await newRequest(run, { sourceId: 'ward-b2' });
  await newRequest(run, { sourceId: 'ward-b2', testGroup: 'blood-count' });
  const d = await run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'qc-failed', backup: 'partner-lab', workOrderId: wo.workOrderId, expectedBackHours: 4 }, 'lab-scientist');
  out('ospeli_diagnostics_equipment_set', d);
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'hold' }, 'diagnostics-manager'), code('conflict'), 'already down');
  const ov = await run('ospeli_diagnostics_overview', {}, 'ward-nurse');
  const row = ov.equipment.find((x) => x.assetId === 'asset-analyser-1');
  assert.deepEqual([row.state, row.workOrder.id, row.backupText, row.testGroupsOff.map((g) => g.id)], ['down', wo.workOrderId, 'Send to: the partner laboratory, by the usual transport', ['chemistry', 'urine']]);
  assert.match(row.expectedBackText, /^Estimate: back by 14:00 \(set at 10:00\)$/);
  const notes = ov.guide.suggestions.filter((s) => s.rule === 'equipment-down');
  assert.ok(notes.some((s) => s.sourceId === 'ward-a2' && s.requestIds.includes(a2) && /partner laboratory/.test(s.text)));
  assert.ok(notes.some((s) => s.sourceId === 'ward-b2' && /1 open request from .*\(blood chemistry\)/.test(s.text)), 'blood count is not run by this analyser: not counted');
  advance(120);
  await run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'up' }, 'diagnostics-manager');
  const ov2 = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  const av = ov2.kpis[2].byAsset.find((x) => x.assetId === 'asset-analyser-1');
  assert.equal(av.downHours, 2, 'two hours down');
  assert.ok(!ov2.guide.suggestions.some((s) => s.rule === 'equipment-down'));
  // Partly down: one test group off.
  await run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'partly-down', reason: 'no-reagent', backup: 'hold', testGroups: ['urine'] }, 'lab-scientist');
  const ov3 = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  assert.ok(!ov3.guide.suggestions.some((s) => s.rule === 'equipment-down'), 'no open urine requests: nothing to show');
  // A radiographer marks the scanner, with no test groups.
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-xray-1', state: 'partly-down', reason: 'breakdown', backup: 'other-room', testGroups: ['urine'] }, 'radiographer'), code('invalid-input'));
  await run('ospeli_diagnostics_equipment_set', { assetId: 'asset-xray-1', state: 'partly-down', reason: 'breakdown', backup: 'other-room' }, 'radiographer');
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-xray-1', state: 'down', reason: 'no-reagent', backup: 'other-room' }, 'radiographer'), code('conflict'));
});

test('agents: a write becomes a proposal and changes nothing until a person accepts; department requests and wards not given are out of reach; people-only commands are refused', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true, 'ward-b1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'dx-bot', role: 'unit-clerk', wards: ['ward-a2'], days: 30 }, 'coo');
  await run('ospeli_agents_add', { name: 'lab-bot', role: 'lab-reception', wards: ['ward-a2'], days: 30 }, 'coo');
  const bot = agent('unit-clerk');
  const n = await core.eventCount();
  const p = await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'urine', urgency: 'routine' }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-b1', testGroup: 'urine', urgency: 'routine' }, bot), code('forbidden'), 'a ward not listed for this agent');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a1', testGroup: 'urine', urgency: 'routine' }, bot), code('agents-off'), 'a ward switched off');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'dept-emergency', testGroup: 'urine', urgency: 'routine' }, bot), code('forbidden'), 'a department cannot be given to an agent');
  // A request from the emergency department is never touched or told about.
  const ed = await newRequest(run, { sourceId: 'dept-emergency' }, 'ae-nic');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: ed, outcome: 'received' }, agent('lab-reception', 'lab-bot')), code('forbidden'));
  const seen = await run('ospeli_diagnostics_requests_list', { stage: 'all', limit: 500 }, bot);
  assert.ok(seen.requests.length && seen.requests.every((r) => r.sourceId === 'ward-a2'), 'an agent sees only its own ward');
  const log = await run('ospeli_diagnostics_specimen_log', {}, agent('lab-reception', 'lab-bot'));
  assert.ok(log.onTheWay.every((b) => b.sourceId === 'ward-a2'));
  // A ward the agent may not see: receive is refused.
  const b1 = await newRequest(run, { sourceId: 'ward-b1' });
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: b1, outcome: 'received' }, agent('lab-reception', 'lab-bot')), code('forbidden'));
  await assert.rejects(run('ospeli_diagnostics_guide_set', { on: false }, bot), code('forbidden'));
  // A made-up request is refused before it queues.
  await assert.rejects(run('ospeli_diagnostics_specimen_collect', { requestId: 'dx-88888' }, bot), code('not-found'));
  // A person accepts: it is recorded as the person's action.
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  assert.equal(acc.status, 'accepted');
  const last = (await core.events({ type: 'diagnostics.request-made' })).at(-1);
  assert.deepEqual([last.data.sourceId, last.data.testGroup, last.actorRole], ['ward-a2', 'urine', 'ward-nurse']);
  // The lab's agent proposes a receipt; nothing happens until accepted.
  const a2 = await newRequest(run);
  const pr = await run('ospeli_diagnostics_specimen_receive', { requestId: a2, outcome: 'received' }, agent('lab-reception', 'lab-bot'));
  assert.equal(pr.status, 'proposed');
  assert.equal(deriveRequests(await core.events()).get(a2).state, 'requested');
  const again = await run('ospeli_diagnostics_specimen_receive', { requestId: a2, outcome: 'received' }, agent('lab-reception', 'lab-bot'));
  assert.deepEqual([again.existing, again.proposal.id], [true, pr.proposal.id], 'the same proposal is not queued twice');
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: a2, outcome: 'rejected', reason: 'leaked' }, agent('lab-reception', 'lab-bot')), code('conflict'), 'one open proposal per request');
  await run('ospeli_proposals_accept', { id: pr.proposal.id }, 'lab-scientist');
  assert.equal(deriveRequests(await core.events()).get(a2).state, 'received');
});

test('the guide switch: people only, the manager only; with it off there are no suggestions and no "not arrived" flags, and everything else is the same', async () => {
  const { run } = await site();
  const on = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  const logOn = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  assert.ok(on.guide.suggestions.length >= 2 && logOn.notArrived.length >= 1);
  await assert.rejects(run('ospeli_diagnostics_guide_set', { on: true }, 'diagnostics-manager'), code('conflict'));
  const g = await run('ospeli_diagnostics_guide_set', { on: false }, 'diagnostics-manager');
  out('ospeli_diagnostics_guide_set', g);
  const off = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  const logOff = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  assert.deepEqual(logOff.notArrived, []);
  assert.equal(logOff.counts.onTheWay, logOn.counts.onTheWay, 'the specimens are all still listed, in their blocks');
  assert.equal(logOff.onTheWay.reduce((s, b) => s + b.count, 0), logOn.counts.onTheWay);
  const same = (x) => JSON.stringify([x.kpis, x.counts, x.equipment]);
  assert.equal(same(off), same(on), 'measures, counts and equipment are the same with the guide off');
  await run('ospeli_diagnostics_guide_set', { on: true }, 'diagnostics-manager');
});

test('an edited import: a sentence in an id or a pick that is not on the list is dropped, never shown (#138)', () => {
  const at = '2026-11-02T08:00:00.000Z';
  const evs = [
    { type: 'diagnostics.request-made', subject: 'dx-00001', at, actorRole: 'unit-clerk', data: { sourceId: 'Ward of Dr Smith', testGroup: 'chemistry', urgency: 'routine' } },
    { type: 'diagnostics.request-made', subject: 'dx-00002', at, actorRole: 'unit-clerk', data: { sourceId: 'ward-a1', testGroup: 'potassium level 6.1', urgency: 'routine' } },
    { type: 'diagnostics.request-made', subject: 'dx-00003', at, actorRole: 'unit-clerk', data: { sourceId: 'ward-a1', testGroup: 'chemistry', urgency: 'routine', encounter: 'Jane Doe' } },
    { type: 'diagnostics.specimen-rejected', subject: 'dx-00003', at, actorRole: 'lab-reception', data: { reason: 'the nurse was careless' } },
    { type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', at, actorRole: 'lab-scientist', data: { scope: 'all', reason: 'Broken by J. Smith', backup: 'hold' } },
  ];
  const r = deriveRequests(evs);
  assert.deepEqual([...r.keys()], ['dx-00003']);
  assert.deepEqual([r.get('dx-00003').encounter, r.get('dx-00003').state], [null, 'requested']);
  assert.equal(deriveEquipment(evs).size, 0);
});

test('a result release tapped by mistake: undone by a laboratory scientist within five minutes with a picked reason; it leaves the turnaround', async () => {
  const { run, advance, core } = await site();
  const a = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception');
  advance(30);
  await run('ospeli_diagnostics_result_record', { requestId: a }, 'lab-scientist');
  const win = { since: '2026-11-19T00:00:00.000Z', until: '2026-11-20T00:00:00.000Z' };
  const n0 = labTurnaround(deriveRequests(await core.events()), win).n;
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'tapped-by-mistake' }, 'lab-reception'), code('forbidden'), 'only a scientist undoes a release');
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: a }, 'lab-scientist'), code('invalid-input'), 'the reason is picked');
  const u = await run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'wrong-request' }, 'lab-scientist');
  assert.equal(u.state, 'received', 'back to waiting for its result');
  assert.equal(labTurnaround(deriveRequests(await core.events()), win).n, n0 - 1, 'the undone release leaves the turnaround');
  assert.deepEqual((await core.events({ subject: a })).map((e) => e.type.slice(12)), ['request-made', 'specimen-received', 'result-validated', 'specimen-undone'], 'both events kept');
  await run('ospeli_diagnostics_result_record', { requestId: a }, 'lab-scientist');
  advance(6);
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: a, reason: 'tapped-by-mistake' }, 'lab-scientist'), code('conflict'), 'five minutes only');
});

test('a "Collected" marked by mistake: the ward undoes it before the lab receives it, within five minutes, with a picked reason; people only', async () => {
  const { run, advance } = await site();
  const a = await newRequest(run);
  await run('ospeli_diagnostics_specimen_collect', { requestId: a }, 'unit-clerk');
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'wrong-request' }, 'lab-reception'), code('forbidden'));
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'oops' }, 'unit-clerk'), code('invalid-input'));
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'wrong-request' }, agent('unit-clerk')), (e) => ['agents-off', 'forbidden'].includes(e.code));
  const u = await run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'wrong-request' }, 'ward-nurse');
  out('ospeli_diagnostics_collect_undo', u);
  const row = (await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, 'unit-clerk')).requests.find((r) => r.id === a);
  assert.deepEqual([row.state, row.stage], ['requested', 'Not collected']);
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'wrong-request' }, 'unit-clerk'), code('conflict'), 'nothing to undo');
  await run('ospeli_diagnostics_specimen_collect', { requestId: a }, 'unit-clerk');
  await run('ospeli_diagnostics_specimen_receive', { requestId: a, outcome: 'received' }, 'lab-reception');
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: a, reason: 'wrong-request' }, 'unit-clerk'), code('conflict'), 'already at the lab');
  const b = await newRequest(run);
  await run('ospeli_diagnostics_specimen_collect', { requestId: b }, 'unit-clerk');
  advance(6);
  await assert.rejects(run('ospeli_diagnostics_collect_undo', { requestId: b, reason: 'not-taken' }, 'unit-clerk'), code('conflict'), 'five minutes only');
});

test('the tracker: a finished request shows when its step happened, with the day when it is not today, and no minutes in the step', async () => {
  const { run } = await site();
  const list = (await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2', stage: 'all', limit: 500 }, 'unit-clerk')).requests;
  const done = list.filter((r) => ['released', 'rejected', 'cancelled'].includes(r.state));
  assert.ok(done.length > 10);
  for (const r of done) assert.equal(r.minutesInStep, null, `${r.id}: no minutes once finished`);
  for (const r of list.filter((x) => ['requested', 'collected', 'received'].includes(x.state))) assert.ok(Number.isInteger(r.minutesInStep));
  const old = done.find((r) => r.state === 'released' && r.releasedAt < '2026-11-19T04:00:00.000Z');
  assert.match(old.stepAt, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} Nov, \d\d:\d\d$/, 'another day says the day');
  assert.match(old.clocks.made, /Nov, /);
  const today = list.find((r) => r.state === 'released' && r.releasedAt >= '2026-11-19T04:00:00.000Z');
  if (today) assert.match(today.stepAt, /^\d\d:\d\d$/, 'today: the time only');
});
