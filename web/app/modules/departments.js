// Departments (navigation v2, ospeli/ospeli docs/design/navigation-v2.md): where a person works.
// The department sets the pages shown first, which module is marked on the Journey page, the flow
// stages on Now and the walk's step and role words (modules/walk.js reads ctx.department).
// Every list here is an example setting a site can edit, not a standard. Plain data only.
// `module`: the department's own module on the Journey page. `pinned`: pages shown first on Now.
// `role`: the job title a device starts with when no one has chosen one yet (changed under Me).
// `stages`: the flow strip on Now, left to right; `pages` are the pages that serve the stage.
// `place`: the department's place id in the example hospital (wards: every ward), for what Now counts there.
export const DEPARTMENTS = [
  { id: 'imaging', place: 'dept-imaging', name: 'Imaging', hint: 'X-ray, CT, ultrasound and other scans', module: 'diagnostics', pinned: ['diagnostics', 'clinics', 'engineering', 'transfers'], role: 'radiographer',
    stages: [{ id: 'arrive', name: 'Arrive', pages: ['clinics'] }, { id: 'prep', name: 'Prep', pages: ['diagnostics'] }, { id: 'scan', name: 'Scan', pages: ['engineering', 'diagnostics'] }, { id: 'leave', name: 'Leave', pages: ['transfers'] }] },
  { id: 'outpatients', place: 'dept-outpatients', name: 'Outpatients and clinics', short: 'Outpatients', hint: 'Booked clinics and their queues', module: 'clinics', pinned: ['clinics', 'feedback', 'diagnostics'], role: 'clinic-receptionist',
    stages: [{ id: 'arrive', name: 'Arrive', pages: ['clinics'] }, { id: 'wait', name: 'Wait', pages: ['clinics'] }, { id: 'seen', name: 'Seen', pages: ['clinics', 'diagnostics'] }, { id: 'leave', name: 'Leave', pages: ['pharmacy', 'transfers'] }] },
  { id: 'emergency', place: 'dept-emergency', name: 'Emergency department', short: 'Emergency', hint: 'Walk-in and ambulance arrivals', module: 'ae', pinned: ['beds', 'transfers', 'diagnostics'], role: 'ae-nic',
    stages: [{ id: 'arrive', name: 'Arrive', pages: ['transfers'] }, { id: 'assess', name: 'Assess', pages: ['diagnostics'] }, { id: 'treat', name: 'Treat', pages: ['diagnostics', 'pharmacy'] }, { id: 'leave', name: 'Leave', pages: ['beds', 'transfers'] }] },
  { id: 'pharmacy', place: null, name: 'Pharmacy', hint: 'Dispensing and discharge medicines', module: 'pharmacy', pinned: ['pharmacy', 'stores'], role: 'pharmacy-technician',
    stages: [{ id: 'received', name: 'Received', pages: ['pharmacy'] }, { id: 'prepared', name: 'Prepared', pages: ['pharmacy', 'stores'] }, { id: 'checked', name: 'Checked', pages: ['pharmacy'] }, { id: 'collected', name: 'Collected', pages: ['pharmacy'] }] },
  { id: 'laboratory', place: 'dept-laboratory', name: 'Laboratory', hint: 'Samples from asked to done', module: 'diagnostics', pinned: ['diagnostics', 'stores', 'engineering'], role: 'lab-scientist',
    stages: [{ id: 'asked', name: 'Asked', pages: ['diagnostics'] }, { id: 'collected', name: 'Collected', pages: ['diagnostics'] }, { id: 'received', name: 'Received', pages: ['diagnostics', 'engineering'] }, { id: 'done', name: 'Done', pages: ['diagnostics'] }] },
  { id: 'wards', place: 'ward-*', name: 'Wards', hint: 'Beds, discharges and ward supplies', module: 'beds', pinned: ['beds', 'support', 'stores', 'pharmacy'], role: 'ward-nurse',
    stages: [{ id: 'arrive', name: 'Arrive', pages: ['beds'] }, { id: 'stay', name: 'Stay', pages: ['beds', 'stores'] }, { id: 'ready', name: 'Ready to leave', pages: ['pharmacy', 'beds'] }, { id: 'leave', name: 'Leave', pages: ['transfers', 'support'] }] },
  { id: 'whole-hospital', place: '*', name: 'Whole hospital (managers)', short: 'Whole hospital', hint: 'Every department, for managers', module: null, pinned: ['beds', 'process', 'engineering'], role: 'ops-manager',
    stages: [{ id: 'arrive', name: 'Arrive and book', pages: ['clinics', 'feedback'] }, { id: 'test', name: 'Test and treat', pages: ['diagnostics', 'pharmacy'] }, { id: 'stay', name: 'Stay', pages: ['beds'] }, { id: 'leave', name: 'Leave and move', pages: ['transfers'] }] },
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
