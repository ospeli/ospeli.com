// Transfers and vehicles: which screens a role has, and which screens show an agent's proposal with
// Accept and Decline (ospeli/ospeli#148). Plain data and rules, no screen code: the view uses it, and
// the shell's "Waiting for your decision" (modules/screens.js) reads it to link to the right screen.
export const TITLES = { jobs: 'My jobs', board: 'Dispatch board', request: 'Book a transfer', fleet: 'Fleet status' };
export function screensFor(role) {
  if (role === 'driver') return ['jobs', 'fleet'];
  if (role === 'transport-coordinator') return ['board', 'request', 'fleet'];
  if (role === 'fleet-supervisor') return ['fleet', 'board'];
  if (role === 'ward-nurse' || role === 'ae-nic') return ['request', 'board'];
  if (role === 'bed-manager') return ['board', 'request'];
  return ['board', 'fleet'];
}
export function shownOn(p) {
  if (/^ospeli_transfers_vehicle_/.test(p.command)) return ['fleet', 'board'];
  return /^ospeli_transfers_/.test(p.command) ? ['board'] : [];
}
