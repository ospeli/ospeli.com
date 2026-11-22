// modules/ui.js redrawOnChange (ospeli/ospeli#153): a page redraws when the data changes, except
// when the only changes were its own and it has already started reading again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redrawOnChange } from '../../web/app/modules/ui.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function page() {
  const listeners = new Set();
  const flow = { writing: 0, writeDoneAt: 0, readStartedAt: 0, n: 0 };
  const ctx = { flow, core: { onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } } };
  let reloads = 0;
  const off = redrawOnChange(ctx, () => { reloads += 1; }, { wait: 10 });
  return {
    flow, off, listeners,
    emit: (kind, detail = null) => { for (const fn of listeners) fn({ kind, detail }); },
    writeStarts: () => { flow.writing += 1; },
    writeSaved: () => { flow.writing -= 1; flow.writeDoneAt = ++flow.n; },
    readStarts: () => { flow.readStartedAt = ++flow.n; },
    reloads: () => reloads,
  };
}

test('the page\'s own change, then its own reload: no second redraw', async () => {
  const p = page();
  p.writeStarts(); p.emit('event'); p.writeSaved(); p.readStarts();
  await wait(40);
  assert.equal(p.reloads(), 0);
  p.off();
});

test('the page\'s own change with no reload of its own: it is redrawn', async () => {
  const p = page();
  p.writeStarts(); p.emit('event'); p.writeSaved();
  await wait(40);
  assert.equal(p.reloads(), 1);
  p.off();
});

test('a read that started before the change was saved does not count: it is redrawn', async () => {
  const p = page();
  p.readStarts(); p.writeStarts(); p.emit('event'); p.writeSaved();
  await wait(40);
  assert.equal(p.reloads(), 1);
  p.off();
});

test('a change still being saved is waited for, then judged', async () => {
  const p = page();
  p.writeStarts(); p.emit('event');
  await wait(40);
  assert.equal(p.reloads(), 0, 'not yet: the save is still running');
  p.writeSaved();
  await wait(40);
  assert.equal(p.reloads(), 1, 'saved and the page did not reload itself');
  p.off();
});

test('a change this page did not make always redraws: an agent or another page (nothing being saved here), another tab, and one mixed in with its own', async () => {
  const a = page();
  a.emit('proposals'); a.readStarts();
  await wait(40);
  assert.equal(a.reloads(), 1, 'nothing was being saved by this page');
  const b = page();
  b.writeStarts(); b.emit('events', { from: 'another tab' }); b.writeSaved(); b.readStarts();
  await wait(40);
  assert.equal(b.reloads(), 1, 'another tab');
  const c = page();
  c.writeStarts(); c.emit('event'); c.writeSaved(); c.readStarts(); c.emit('event');
  await wait(40);
  assert.equal(c.reloads(), 1, 'its own change and then someone else\'s');
  // After a redraw the next batch is judged afresh.
  c.writeStarts(); c.emit('event'); c.writeSaved(); c.readStarts();
  await wait(40);
  assert.equal(c.reloads(), 1);
  for (const p of [a, b, c]) p.off();
});

test('kinds it was not asked about are ignored, no flow means every change redraws, and off() stops it', async () => {
  const p = page();
  p.emit('audit'); p.emit('meta');
  await wait(30);
  assert.equal(p.reloads(), 0);
  p.emit('reset'); p.off();
  await wait(30);
  assert.equal(p.reloads(), 0, 'stopped before the redraw was due');
  assert.equal(p.listeners.size, 0);
  let n = 0; const fns = new Set();
  const off = redrawOnChange({ core: { onChange: (fn) => { fns.add(fn); return () => fns.delete(fn); } } }, () => { n += 1; }, { wait: 5 });
  for (const fn of fns) fn({ kind: 'event', detail: null });
  await wait(30);
  assert.equal(n, 1);
  off();
});
