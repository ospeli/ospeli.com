// Stores and supplies: which screens a role has, and which screens show an agent's proposal with
// Accept and Decline (ospeli/ospeli#148). Plain data and rules, no screen code: the view uses it, and
// the shell's "Waiting for your decision" (modules/screens.js) reads it to link to the right screen.
export const TITLES = { count: 'Ward stock count', requests: 'Requests and issues', receive: 'Receive a delivery', orders: 'Order tracker', outs: 'Stock-out log', manage: 'Supplies overview' };
export function screensFor(role) {
  if (role === 'ward-nurse') return ['count', 'outs'];
  if (role === 'storekeeper') return ['requests', 'receive', 'outs', 'orders'];
  if (role === 'supply-manager') return ['manage', 'orders', 'requests', 'outs'];
  if (role === 'ops-manager' || role === 'coo') return ['manage', 'orders', 'outs'];
  return ['manage', 'requests', 'orders', 'outs'];
}
export const shownOn = (p) => (/^ospeli_(stores|stock)_/.test(p.command) ? ['count', 'manage', 'requests', 'orders'] : []);
