// Departments (navigation v2, ospeli/ospeli docs/design/navigation-v2.md): where a person works.
// The department sets the pages shown first, which module is marked on the Journey page, the flow
// stages on Now and the walk's step and role words (modules/walk.js reads ctx.department).
// Every list here is an example setting, not a standard; a site cannot edit them on screen yet.
// Plain data only.
// `module`: the department's own module on the Journey page. `pinned`: pages shown first on Now.
// `role`: the job title a device starts with when no one has chosen one yet (changed under Me).
// `stages`: the flow strip on Now, left to right; `pages` are the pages that serve the stage;
// `unit`: what one counted item on the tile is (shown with every number, plural with "s");
// `planned: true`: the stage would be counted by a module that is planned, not built, so it has no
// tile and Now says so in words; `tile`: the tile's own words where they differ from the stage name.
// Crew night 5 item 1: a tile's visible words say what its number counts ("Ready to collect",
// "Booked, not arrived"), not only the stage it sits at; the stage name stays for the flow order.
// Where the stage name is kept on the tile (Imaging), a short line under the unit says what is counted.
// `place`: the department's place id in the example hospital (wards: every ward), for what Now counts there.
//
// Tile dictionary (ospeli/ospeli#183 item 6, decision record 2026-11-25-now-flow-strip.md). The
// planning repo's EVIDENCE.md is not in this repo, so the dictionary lives here. For each tile:
// unit · time window · source and the states it counts. "Now" means the moment of the read; the
// strip shows that moment as "As of hh:mm". Every count is of items, never of a named person.
// Imaging
//   Arrive · patients · now · ospeli_tasks_list (kind patient-move, open = waiting or under way) going to Imaging.
//   Prep, Scan · not counted: no page holds imaging patients by stage yet.
//   Leave · patients · now · open patient moves starting in Imaging (ospeli_tasks_list) plus journeys
//     from Imaging waiting for a vehicle (ospeli_transfers_board, waiting). One patient each.
//   Waits with a start time: moves not started yet (minutes since asked), journeys waiting for a vehicle.
// Outpatients (ospeli_clinics_day_summary, today's clinics only)
//   Arrive · patients · today · booked, not arrived yet. Wait · patients · now · arrived, not called.
//   Seen · patients · now · with the clinician. Leave · not counted.
//   Waits with a start time: each patient waiting now (ospeli_clinics_queue, arrived), from the later
//     of arrival and booked time (crew night 5 item 3), never from an early arrival.
// Emergency (the emergency department module is planned, not built)
//   Arrive, Assess, Treat · planned, not built: no tile.
//   Leave, shown as "Waiting for a ward bed" · patients · now · ospeli_beds_board waiting list, every
//     patient on it; longest = minutes since the decision to admit (the start the bed board shows).
// Pharmacy (ospeli_pharmacy_overview, open requests by stage) · requests · now
//   Received = raised, Prepared = being prepared, Checked = checked, Collected = ready to collect.
//   Requests on hold are in no stage. No wait line: time by stage is on the Pharmacy page.
// Laboratory (ospeli_diagnostics_requests_list, stage current) · requests
//   Asked = not collected, Collected = on the way, Received = in the lab: open work, now.
//   Done = results released in the last 24 h: work finished, not open; shown apart from open work.
//   Waits with a start time: each open request's minutes in its present step (on its tile, never the headline).
// Wards (ospeli_beds_board, short; ospeli_transfers_board)
//   Arrive · patients · now · waiting-for-a-bed list (from the decision to admit).
//   Stay · beds · now · occupied beds with no discharge date (bed state occupied).
//   Expected to leave · beds · now · occupied beds with a discharge date (bed state expected-discharge).
//     It does not mean anyone is ready. Stay + Expected to leave = every occupied bed.
//   Leave · journeys · now · journeys from a ward waiting for a vehicle (ospeli_transfers_board, waiting).
//   Waits with a start time: bed waits (minutes since the decision to admit), vehicle waits (minutes since asked).
// Whole hospital
//   Arrive and book · patients · now · waiting in today's clinics. Test and treat · requests · now ·
//   open lab requests (not collected, on the way, in the lab). Stay · beds · now · every occupied
//   bed, with or without a discharge date. Leave and move · journeys · now · waiting for a vehicle.
//   Waits with a start time: clinic waits, open lab requests' time in step, bed waits, vehicle waits.
// The headline over the strip (crew night 5 item 2): the longest patient's wait whenever one has a
// start time, named with its unit and what it is for; a longer vehicle wait is said under it. A
// vehicle wait heads it only when no patient wait is timed. A request never heads it: no module
// here gives a request an expected time with a source, so its age is on its own tile ("oldest
// 21 h 50 min") and, with no patient wait, the strip says there is no timed patient wait. Where a
// stage is not counted, planned or has waits with no start time, it reads "Longest timed wait" and
// says what is left out.
// `wait` (Now review, 26 Nov): whether people wait at this stage and the reads give that wait a
// start time: 'timed' or 'untimed'. No `wait`: nobody waits there as a patient (beds, requests,
// booked but not here, with the clinician), or the wait is on another tile (Outpatients Leave: for
// medicines, a request, or a vehicle, timed under Leave and move). "Longest wait now" only when no
// stage is 'untimed' and every stage is counted; `noun`: the stage in the "Not timed" list where its
// name is a verb. `every: true` (Whole hospital): also left out is every other department's
// 'untimed' stage, named from these lists ("emergency department steps, imaging prep and scan").
export const DEPARTMENTS = [
  { id: 'imaging', place: 'dept-imaging', name: 'Imaging', hint: 'X-ray, CT, ultrasound and other scans', module: 'diagnostics', pinned: ['diagnostics', 'clinics', 'engineering', 'transfers'], role: 'radiographer',
    stages: [{ id: 'arrive', name: 'Arrive', pages: ['clinics'], unit: 'patient', wait: 'timed' }, { id: 'prep', name: 'Prep', pages: ['diagnostics'], wait: 'untimed' }, { id: 'scan', name: 'Scan', pages: ['engineering', 'diagnostics'], wait: 'untimed' }, { id: 'leave', name: 'Leave', pages: ['transfers'], unit: 'patient', wait: 'timed' }] },
  { id: 'outpatients', place: 'dept-outpatients', name: 'Outpatients and clinics', short: 'Outpatients', hint: 'Booked clinics and their queues', module: 'clinics', pinned: ['clinics', 'feedback', 'diagnostics'], role: 'clinic-receptionist',
    stages: [{ id: 'arrive', name: 'Arrive', tile: 'Booked, not arrived', pages: ['clinics'], unit: 'patient' }, { id: 'wait', name: 'Wait', tile: 'Arrived, waiting', pages: ['clinics'], unit: 'patient', wait: 'timed' }, { id: 'seen', name: 'Seen', tile: 'With clinician', pages: ['clinics', 'diagnostics'], unit: 'patient' }, { id: 'leave', name: 'Leave', pages: ['pharmacy', 'transfers'] }] },
  { id: 'emergency', place: 'dept-emergency', name: 'Emergency department', short: 'Emergency', hint: 'Walk-in and ambulance arrivals', module: 'ae', pinned: ['beds', 'transfers', 'diagnostics'], role: 'ae-nic',
    stages: [{ id: 'arrive', name: 'Arrive', noun: 'arrival', pages: ['transfers'], planned: true, wait: 'untimed' }, { id: 'assess', name: 'Assess', noun: 'assessment', pages: ['diagnostics'], planned: true, wait: 'untimed' }, { id: 'treat', name: 'Treat', noun: 'treatment', pages: ['diagnostics', 'pharmacy'], planned: true, wait: 'untimed' }, { id: 'leave', name: 'Leave', tile: 'Waiting for a ward bed', pages: ['beds', 'transfers'], unit: 'patient', wait: 'timed' }] },
  { id: 'pharmacy', place: null, name: 'Pharmacy', hint: 'Dispensing and discharge medicines', module: 'pharmacy', pinned: ['pharmacy', 'stores'], role: 'pharmacy-technician',
    stages: [{ id: 'received', name: 'Received', tile: 'Not started', pages: ['pharmacy'], unit: 'request' }, { id: 'prepared', name: 'Prepared', tile: 'Being prepared', pages: ['pharmacy', 'stores'], unit: 'request' }, { id: 'checked', name: 'Checked', tile: 'Checked, not ready', pages: ['pharmacy'], unit: 'request' }, { id: 'collected', name: 'Collected', tile: 'Ready to collect', pages: ['pharmacy'], unit: 'request' }] },
  { id: 'laboratory', place: 'dept-laboratory', name: 'Laboratory', hint: 'Samples from asked to done', module: 'diagnostics', pinned: ['diagnostics', 'stores', 'engineering'], role: 'lab-scientist',
    stages: [{ id: 'asked', name: 'Asked', tile: 'Not collected', pages: ['diagnostics'], unit: 'request' }, { id: 'collected', name: 'Collected', tile: 'On the way', pages: ['diagnostics'], unit: 'request' }, { id: 'received', name: 'Received', tile: 'In the lab', pages: ['diagnostics', 'engineering'], unit: 'request' }, { id: 'done', name: 'Done', tile: 'Released', pages: ['diagnostics'], unit: 'request', apart: true }] },
  { id: 'wards', place: 'ward-*', name: 'Wards', hint: 'Beds, discharges and ward supplies', module: 'beds', pinned: ['beds', 'support', 'stores', 'pharmacy'], role: 'ward-nurse',
    stages: [{ id: 'arrive', name: 'Arrive', tile: 'Waiting for a bed', pages: ['beds'], unit: 'patient', wait: 'timed' }, { id: 'stay', name: 'Stay', tile: 'Staying', pages: ['beds', 'stores'], unit: 'bed' }, { id: 'ready', name: 'Expected to leave', tile: 'Expected to leave', pages: ['pharmacy', 'beds'], unit: 'bed' }, { id: 'leave', name: 'Leave', tile: 'Awaiting vehicle', pages: ['transfers', 'support'], unit: 'journey', wait: 'timed' }] },
  { id: 'whole-hospital', place: '*', name: 'Whole hospital (managers)', short: 'Whole hospital', hint: 'Every department, for managers', module: null, pinned: ['beds', 'process', 'engineering'], role: 'ops-manager',
    stages: [{ id: 'arrive', name: 'Arrive and book', tile: 'Waiting in clinics', pages: ['clinics', 'feedback'], unit: 'patient', wait: 'timed' }, { id: 'test', name: 'Test and treat', tile: 'Open in the lab', pages: ['diagnostics', 'pharmacy'], unit: 'request' }, { id: 'stay', name: 'Stay', tile: 'Occupied', pages: ['beds'], unit: 'bed', wait: 'timed' }, { id: 'leave', name: 'Leave and move', tile: 'Awaiting vehicle', pages: ['transfers'], unit: 'journey', wait: 'timed' }], every: true },
];
export const departmentById = (id) => DEPARTMENTS.find((d) => d.id === id) || null;
export const departmentShort = (d) => d.short || d.name;

// A device whose role was set for it (a site server) starts in the department that role works in.
const ROLE_DEPARTMENT = {
  radiographer: 'imaging', 'lab-reception': 'laboratory', 'lab-scientist': 'laboratory', 'diagnostics-manager': 'laboratory', 'unit-clerk': 'wards',
  'clinic-receptionist': 'outpatients', 'clinic-nurse': 'outpatients', 'booking-clerk': 'outpatients', 'outpatient-manager': 'outpatients',
  'ae-nic': 'emergency', 'pharmacy-technician': 'pharmacy', pharmacist: 'pharmacy', 'pharmacy-manager': 'pharmacy', 'ward-nurse': 'wards', 'bed-manager': 'wards',
};
export const departmentForRole = (roleId) => ROLE_DEPARTMENT[roleId] || 'whole-hospital';

// The role list under Me, by department (#166 item 3): headings and order only. A role sits in
// every department where it works (Diagnostics manager: Imaging and Laboratory) and is listed once,
// in the first group shown, the chosen department's first. Roles of no one department (transport,
// cleaning, stores, facilities, engineering) are under "Support services". Role ids do not change.
export const ROLE_GROUPS = {
  imaging: ['radiographer', 'diagnostics-manager'],
  outpatients: ['clinic-receptionist', 'clinic-nurse', 'booking-clerk', 'outpatient-manager'],
  emergency: ['ae-nic'],
  pharmacy: ['pharmacy-technician', 'pharmacist', 'pharmacy-manager'],
  laboratory: ['lab-reception', 'lab-scientist', 'diagnostics-manager'],
  wards: ['ward-nurse', 'bed-manager', 'unit-clerk'],
  'whole-hospital': ['ops-manager', 'coo', 'quality-lead', 'patient-liaison', 'receptionist'],
};
export const SUPPORT_GROUP = 'Support services';
// [{ label, ids }]: the chosen department's group first, then the departments in their order, then
// support services; every role id given exactly once; a role in no group goes under support services.
export function roleGroups(roleIds, chosen) {
  const order = [...DEPARTMENTS.filter((d) => d.id === chosen), ...DEPARTMENTS.filter((d) => d.id !== chosen)];
  const left = new Set(roleIds);
  const groups = [];
  for (const d of order) {
    const ids = (ROLE_GROUPS[d.id] || []).filter((id) => left.has(id));
    ids.forEach((id) => left.delete(id));
    if (ids.length) groups.push({ label: departmentShort(d), ids });
  }
  const rest = roleIds.filter((id) => left.has(id));
  if (rest.length) groups.push({ label: SUPPORT_GROUP, ids: rest });
  return groups;
}

// The Journey page: the patient's journey as a spine of stages, each with the modules that serve
// it, then the two boxes. Module ids are from modules/registry.js; planned modules are never
// listed here: they appear only under "Coming later".
export const JOURNEY = [
  { id: 'arrive', name: 'Arrive and book', modules: ['clinics', 'feedback'] },
  { id: 'test', name: 'Test and treat', modules: ['diagnostics', 'pharmacy'] },
  { id: 'stay', name: 'Stay', modules: ['beds'] },
  { id: 'leave', name: 'Leave and move', modules: ['transfers'], forward: true },
];
export const KEEPS_RUNNING = ['stores', 'support', 'facilities', 'engineering'];
export const SEE_AND_IMPROVE = ['process'];
// Pages reached from Me, not from the Journey page.
export const ME_PAGES = ['agents', 'data'];
// Shorter words on a Journey chip where the module's full name is long.
export const CHIP_NAMES = { process: 'Walks and maps', support: 'Cleaning and transport', clinics: 'Clinics', feedback: 'Feedback', stores: 'Stores', facilities: 'Facilities', transfers: 'Transfers', pharmacy: 'Pharmacy' };
