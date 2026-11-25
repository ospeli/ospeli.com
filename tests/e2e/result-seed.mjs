// Walks made through the command layer for the Result tab tests (walk-first week, crew night 3).
// Synthetic only: a made-up imaging visit at a fictional site; made-up step names and times.
// The page's clock must be installed (openPage with clock); time is moved between taps.

export const ME = { type: 'human', role: 'ops-manager' };
const run = (page, name, input = {}) => page.evaluate(async ([n, i, me]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, me);
}, [name, input, ME]);

// The six-step list of the first walk: [name, role].
export const IMAGING = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Imaging staff'], ['Cannula or prep', 'Radiology nurse'], ['Scan', 'Imaging staff'], ['Left', 'Patient']];

// A walk. steps: { wait, work, name?, role? (first walk), off?: [name, role] (not on the list),
// again?: list step number (done again), stopAfter?, stood? (interrupted after stopAfter s of
// work, stood still for stood s, then carried on) }. mapId: walk that map again.
export async function walkIt(page, steps, { title = 'Outpatient CT', mapId = null, department = 'imaging', leftover = null } = {}) {
  await run(page, 'ospeli_walks_start', { ...(mapId ? { mapId } : { title }), guidanceSeen: true, department });
  for (const s of steps) {
    await page.clock.fastForward(s.wait * 1000);
    await run(page, 'ospeli_walks_step_start');
    if (s.stopAfter) {
      await page.clock.fastForward(s.stopAfter * 1000);
      await run(page, 'ospeli_walks_step_done', { interrupted: true });
      if (!mapId) await run(page, 'ospeli_walks_step_name', { name: s.name, role: s.role });
      await page.clock.fastForward(s.stood * 1000);
      await run(page, 'ospeli_walks_step_start', { resume: true });
      await page.clock.fastForward((s.work - s.stopAfter) * 1000);
    } else await page.clock.fastForward(s.work * 1000);
    await run(page, 'ospeli_walks_step_done');
    if (s.off) await run(page, 'ospeli_walks_step_name', { offList: true, name: s.off[0], role: s.off[1] });
    else if (s.again) await run(page, 'ospeli_walks_step_name', { listStep: s.again });
    else if (!mapId) await run(page, 'ospeli_walks_step_name', { name: s.name, role: s.role });
  }
  const out = await run(page, 'ospeli_walks_finish', leftover ? { leftover } : {});
  return out;
}

// Walk 1: the six steps, the prep step interrupted once (stood still 3 min).
//   waits 60, 240, 120, 300, 600, 60 s; hands-on 120, 180, 240, 240 (+180 stood), 900, 30 s.
export const WALK1 = [
  { wait: 60, work: 120 }, { wait: 240, work: 180 }, { wait: 120, work: 240 },
  { wait: 300, work: 240, stopAfter: 120, stood: 180 }, { wait: 600, work: 900 }, { wait: 60, work: 30 },
].map((s, i) => ({ ...s, name: IMAGING[i][0], role: IMAGING[i][1] }));
// Walk 2: an off-list step after prep, and the scan done again; the longest wait is 13 min before the scan.
export const WALK2 = [
  { wait: 30, work: 90 }, { wait: 180, work: 150 }, { wait: 90, work: 200 }, { wait: 240, work: 300 },
  { wait: 120, work: 180, off: ['Contrast check', 'Radiology nurse'] },
  { wait: 780, work: 840 }, { wait: 300, work: 400, again: 5 }, { wait: 45, work: 30 },
];

export async function twoWalkMap(page) {
  await walkIt(page, WALK1);
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK2, { mapId: 'map-001' });
  return 'map-001';
}

// A nine-step list walked three times, for the print page.
export const NINE = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Imaging staff'], ['Changed into gown', 'Patient'], ['Cannula or prep', 'Radiology nurse'],
  ['Scan', 'Imaging staff'], ['Recovery', 'Radiology nurse'], ['Images checked', 'Imaging staff'], ['Left', 'Patient']];
export async function threeWalkNine(page) {
  await walkIt(page, NINE.map(([name, role], i) => ({ name, role, wait: 60 + 40 * i, work: 120 + 20 * i })), { title: 'Outpatient MRI' });
  await page.clock.fastForward(24 * 3600 * 1000);
  await walkIt(page, NINE.map((_, i) => ({ wait: 90 + 30 * i, work: 100 + 25 * i, ...(i === 4 ? { stopAfter: 50, stood: 120 } : {}) })), { mapId: 'map-001' });
  await page.clock.fastForward(24 * 3600 * 1000);
  await walkIt(page, [...NINE.slice(0, 6).map((_, i) => ({ wait: 50 + 70 * i, work: 110 + 15 * i })), { wait: 60, work: 90, off: ['Contrast check', 'Radiology nurse'] },
    ...NINE.slice(6).map((_, i) => ({ wait: 70 + 10 * i, work: 80 + 10 * i }))], { mapId: 'map-001' });
  return 'map-001';
}
