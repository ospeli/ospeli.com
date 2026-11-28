// Issue #197 (Critic, 28 Nov): Now for Pharmacy left out a request on hold (Now said 5 open, the
// queue 6) and no tile said how old its oldest request is. Fed with a made-up queue answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowCounts, flowHeadline } from '../../web/app/modules/home.js';
import { departmentById } from '../../web/app/modules/departments.js';

const AS_OF = '2026-11-27T13:40:00.000Z';
const runner = (answers) => async (name) => { if (!(name in answers)) throw new Error(`no ${name}`); return structuredClone(answers[name]); };
const rq = (id, stage, sinceStepMinutes, held = false) => ({ id, stage, state: held ? 'on-hold' : stage, held, sinceStepMinutes, waitMinutes: sinceStepMinutes + 5 });
const queue = { asOf: AS_OF, total: 6, truncated: false, counts: { raised: 2, started: 1, checked: 1, ready: 1, 'on-hold': 1 }, requests: [
  rq('rx-1', 'raised', 12), rq('rx-2', 'raised', 30), rq('rx-3', 'started', 8), rq('rx-4', 'checked', 4), rq('rx-5', 'ready', 20),
  rq('rx-6', 'raised', 110, true), // on hold: "Waiting for the ward", 1 h 50 min
] };

test('#197: with one request on hold, the Pharmacy strip\'s counts add up to every open request, and the held one is said on its tile', async () => {
  const dept = departmentById('pharmacy');
  const f = await flowCounts(runner({ ospeli_pharmacy_queue_list: queue }), dept);
  const total = dept.stages.reduce((n, s) => n + (f.counts[s.id]?.n || 0), 0);
  assert.equal(total, queue.total, 'the strip counts every open request, the held one included');
  assert.equal(f.counts.received.n, 3);
  assert.equal(f.counts.received.also, '1 on hold');
  assert.equal(f.counts.prepared.also, undefined);
});

test('#197: each Pharmacy tile shows its oldest request; no request heads the strip', async () => {
  const dept = departmentById('pharmacy');
  const f = await flowCounts(runner({ ospeli_pharmacy_queue_list: queue }), dept);
  assert.deepEqual(['received', 'prepared', 'checked', 'collected'].map((t) => [f.counts[t].longest, f.counts[t].oldest]), [[110, true], [8, true], [4, true], [20, true]]);
  const line = flowHeadline(dept, f);
  assert.equal(line.text, null, 'a request never heads the strip');
  assert.match(line.none, /^No timed patient wait/);
});

test('#197: if the queue cannot be read, the overview\'s counts still add up, the held ones included', async () => {
  const dept = departmentById('pharmacy');
  const f = await flowCounts(runner({ ospeli_pharmacy_overview: { asOf: AS_OF, open: 6, counts: { raised: 2, started: 1, checked: 1, ready: 1, 'on-hold': 1 } } }), dept);
  assert.equal(dept.stages.reduce((n, s) => n + (f.counts[s.id]?.n || 0), 0) + 1, 6, 'four stage tiles hold 5');
  assert.equal(f.counts.received.also, '1 more on hold', 'the held one is said on the first tile');
});
