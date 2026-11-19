// Audit finding: the "same check within ten minutes is a double tap" rule compares now - saved time
// with no lower bound. After the device clock is put back (a clock that ran fast is corrected), every
// earlier-stamped moment is "less than ten minutes ago", so the same routine check with the same picks
// is refused as "saved a few minutes ago" until the clock catches up, however long that is.
// (Feedback's own ten-second rule uses the distance between the two times, in either direction.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-19T14:00:00.000Z';
const HOUR = 3600e3;

test('a check twelve hours away from the last one is not a double tap, whichever way the clock moved', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const run = (input) => runCommand(core, 'ospeli_facilities_check_record', input, { type: 'human', role: 'estates-tech' });
  const gas = { checkKind: 'gas-check', placeId: 'bld-main-plant', result: 'pass', levelBand: 'high' };
  await run(gas);
  t -= 12 * HOUR; // the clock had been running fast and is corrected
  const again = await run(gas);
  assert.equal(again.status, 'done');
});
