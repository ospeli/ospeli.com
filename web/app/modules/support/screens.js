// Cleaning and transport: which screens a role has, and which screens show an agent's proposal with
// Accept and Decline (ospeli/ospeli#148). Plain data and rules, no screen code: the view uses it, and
// the shell's "Waiting for your decision" (modules/screens.js) reads it to link to the right screen.
export const TITLES = { jobs: 'My team\'s jobs', board: 'Task board', ask: 'Ask for help', audit: 'Cleaning audit', linen: 'Linen and meals' };
// Transport assistants and cleaners get their own queue and nothing that balances the work between teams.
export function screensFor(role) {
  if (role === 'porter') return ['jobs'];
  if (role === 'cleaner') return ['jobs', 'audit', 'linen'];
  if (role === 'ward-nurse' || role === 'ae-nic') return ['ask', 'board', 'audit', 'linen'];
  if (role === 'support-supervisor' || role === 'bed-manager') return ['board', 'audit', 'ask', 'linen'];
  return ['board', 'audit', 'linen'];
}
// A proposal about linen (a count, top-up or stock-out of a linen item) is decided on Linen and meals.
export const isLinenProposal = (p, linenIds) => {
  const i = p.input || {};
  if (!/^ospeli_stock_/.test(p.command)) return false;
  if (Array.isArray(i.lines)) return i.lines.some((l) => linenIds.has(l.itemId));
  if (p.command === 'ospeli_stock_out_start') return linenIds.has(i.itemId);
  return false;
};
// The screens whose card shows this proposal, best first.
export function shownOn(p, { linenIds = new Set() } = {}) {
  const c = p.command;
  if (c === 'ospeli_support_meals_record' || isLinenProposal(p, linenIds)) return ['linen'];
  if (c === 'ospeli_support_audit_record') return ['audit', 'board'];
  if (/^ospeli_(support|tasks)_/.test(c)) return ['board'];
  return [];
}
