// Where a waiting proposal is decided (ospeli/ospeli#148), for Today and the menu count. Each module
// with more than one screen says, in its own screens.js, which screens a role has and which screens
// show a proposal's card; its view uses the same file, so the link and the card cannot drift apart.
// Small on purpose: Today loads these, not the module views.
import * as support from './support/screens.js';
import * as stores from './stores/screens.js';
import * as transfers from './transfers/screens.js';
import * as clinics from './clinics/screens.js';
import * as pharmacy from './pharmacy/logic.js';

export const SCREENS = { support, stores, transfers, clinics, pharmacy };

// { moduleId, screen } (screen null for a one-page module), or null when no screen this role has
// shows it. A linen proposal goes to Linen and meals when the role has it, else to the stores screens.
export function decideAt(p, role, moduleOf, { linenIds = new Set() } = {}) {
  const home = moduleOf(p.command);
  if (!home) return null;
  const tries = support.isLinenProposal(p, linenIds) ? ['support', home] : [home];
  for (const moduleId of tries) {
    const m = SCREENS[moduleId];
    if (!m) return { moduleId, screen: null };
    const mine = m.screensFor(role);
    const screen = m.shownOn(p, { linenIds }).find((s) => mine.includes(s));
    if (screen) return { moduleId, screen };
  }
  return null;
}
