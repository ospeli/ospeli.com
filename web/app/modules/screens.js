// Which screens (tabs) a role has in the modules with more than one, and where a proposal that waits
// for a person is shown with Accept and Decline (ospeli/ospeli#148). One place, used by the module
// views, by Today and by the menu count, so "Waiting for your decision" links only to a screen the
// role has and that shows the proposal. Small on purpose: Today loads it, not the module views.

export const SCREENS = {
  support: {
    titles: { jobs: 'My team\'s jobs', board: 'Task board', ask: 'Ask for help', audit: 'Cleaning audit', linen: 'Linen and meals' },
    // Transport assistants and cleaners get their own queue and nothing that balances the work between teams.
    for(role) {
      if (role === 'porter') return ['jobs'];
      if (role === 'cleaner') return ['jobs', 'audit', 'linen'];
      if (role === 'ward-nurse' || role === 'ae-nic') return ['ask', 'board', 'audit', 'linen'];
      if (role === 'support-supervisor' || role === 'bed-manager') return ['board', 'audit', 'ask', 'linen'];
      return ['board', 'audit', 'linen'];
    },
  },
  stores: {
    titles: { count: 'Ward stock count', requests: 'Requests and issues', receive: 'Receive a delivery', orders: 'Order tracker', outs: 'Stock-out log', manage: 'Supplies overview' },
    for(role) {
      if (role === 'ward-nurse') return ['count', 'outs'];
      if (role === 'storekeeper') return ['requests', 'receive', 'outs', 'orders'];
      if (role === 'supply-manager') return ['manage', 'orders', 'requests', 'outs'];
      if (role === 'ops-manager' || role === 'coo') return ['manage', 'orders', 'outs'];
      return ['manage', 'requests', 'orders', 'outs'];
    },
  },
  transfers: {
    titles: { jobs: 'My jobs', board: 'Dispatch board', request: 'Book a transfer', fleet: 'Fleet status' },
    for(role) {
      if (role === 'driver') return ['jobs', 'fleet'];
      if (role === 'transport-coordinator') return ['board', 'request', 'fleet'];
      if (role === 'fleet-supervisor') return ['fleet', 'board'];
      if (role === 'ward-nurse' || role === 'ae-nic') return ['request', 'board'];
      if (role === 'bed-manager') return ['board', 'request'];
      return ['board', 'fleet'];
    },
  },
};
export const screensFor = (moduleId, role) => SCREENS[moduleId].for(role);

// A proposal about linen (a count, top-up or stock-out of a linen item) is decided on Linen and meals.
export const isLinenProposal = (p, linenIds) => {
  const i = p.input || {};
  if (Array.isArray(i.lines)) return i.lines.some((l) => linenIds.has(l.itemId));
  if (p.command === 'ospeli_stock_out_start') return linenIds.has(i.itemId);
  return false;
};

// Which screens show a proposal's card, best first. Each module view puts its card on these screens
// with the same rule (`shownOn`), so the two can never drift apart.
export function shownOn(moduleId, p, { linenIds = new Set() } = {}) {
  const c = p.command;
  if (moduleId === 'support') {
    if (c === 'ospeli_support_meals_record' || (/^ospeli_stock_/.test(c) && isLinenProposal(p, linenIds))) return ['linen'];
    if (c === 'ospeli_support_audit_record') return ['audit', 'board'];
    if (/^ospeli_(support|tasks)_/.test(c)) return ['board'];
    return [];
  }
  if (moduleId === 'stores') return /^ospeli_(stores|stock)_/.test(c) ? ['count', 'manage', 'requests', 'orders'] : [];
  if (moduleId === 'transfers') {
    if (/^ospeli_transfers_vehicle_/.test(c)) return ['fleet', 'board'];
    return /^ospeli_transfers_/.test(c) ? ['board'] : [];
  }
  return [];
}

// Where this role decides this proposal: { moduleId, screen } (screen null for a one-page module),
// or null when the role has no screen that shows it. A linen proposal goes to Linen and meals when
// the role has it, else to the stores screens.
export function decideAt(p, role, moduleOf, { linenIds = new Set() } = {}) {
  const home = moduleOf(p.command);
  if (!home) return null;
  const tries = /^ospeli_stock_/.test(p.command) && isLinenProposal(p, linenIds) ? ['support', home] : [home];
  for (const moduleId of tries) {
    if (!SCREENS[moduleId]) return { moduleId, screen: null };
    const mine = screensFor(moduleId, role);
    const screen = shownOn(moduleId, p, { linenIds }).find((s) => mine.includes(s));
    if (screen) return { moduleId, screen };
  }
  return null;
}
