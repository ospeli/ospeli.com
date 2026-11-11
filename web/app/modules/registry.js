// Module registry. Each module is a thin view over the core.
// `load` returns a module object with render(el, ctx) -> optional cleanup function.
// Unbuilt modules show a short "what's coming" page so navigation is complete from day one.

export const MODULES = [
  { id: 'home', name: 'Today', summary: 'Your shortcuts for this role.', load: () => import('./home.js') },
  { id: 'beds', name: 'Bed board', week: 1, summary: 'Live bed state by ward, with flow KPIs.', load: () => import('./beds.js') },
  { id: 'engineering', name: 'Engineering', week: 2, summary: 'Report faults and run the work-order queue.', load: () => import('./engineering.js') },
  { id: 'ae', name: 'A&E flow', week: 2, summary: 'Arrival to decision timeline and pressure level.', soon: 'Follow each attendance from arrival to triage, seen, decision and bed, with the department pressure level and action cards.' },
  { id: 'process', name: 'Process maps', week: 3, summary: 'See where time goes, and try a change safely.', load: () => import('./process.js') },
  { id: 'dashboard', name: 'Operations dashboard', week: 3, summary: 'Top KPIs, flow today and run charts.', soon: 'Top-row KPIs, flow today, discharges by hour and run charts with control limits.' },
  { id: 'incidents', name: 'Incidents and actions', week: 3, summary: 'Report, triage and track actions.', soon: 'Report an incident, triage it, and track actions with owners and due dates.' },
  { id: 'sops', name: 'SOP library', week: 3, summary: 'Procedures with review dates.', soon: 'Standard operating procedures with versions, owners, review dates and staff acknowledgement.' },
  { id: 'knowledge', name: 'Knowledge', week: 4, summary: 'What works, with sources.', soon: 'Search operational evidence offline. Every card shows its source, setting and who reviewed it.' },
  { id: 'playbooks', name: 'Playbooks', week: 4, summary: 'Daily flow report and bottleneck finder.', soon: 'A printable daily flow report and a bottleneck finder that shows the longest waits between steps.' },
  { id: 'agents', name: 'Agents', summary: 'Choose whether AI helpers may read and suggest. Off until you turn it on.', load: () => import('./agents.js') },
  { id: 'data', name: 'Data and audit', summary: 'Export, import, reset and the audit trail.', load: () => import('./data.js') },
];

// Which modules each role uses most, in order. Shown first on the Today page.
export const ROLE_MODULES = {
  'ward-nurse': ['beds', 'engineering', 'incidents', 'sops'],
  'bed-manager': ['beds', 'ae', 'dashboard', 'playbooks'],
  'estates-tech': ['engineering', 'sops', 'incidents'],
  'ae-nic': ['ae', 'beds', 'incidents', 'sops'],
  'ops-manager': ['dashboard', 'process', 'incidents', 'playbooks'],
  coo: ['dashboard', 'playbooks', 'incidents', 'knowledge'],
};

export const moduleById = (id) => MODULES.find((m) => m.id === id) || null;

// Parse "#/beds" or "#/beds/ward-1" into { id, rest }.
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const id = parts[0] && moduleById(parts[0]) ? parts[0] : 'home';
  return { id, rest: parts[0] && moduleById(parts[0]) ? parts.slice(1) : [] };
}
