// Outpatient clinics: which screens a role has, and which screens show an agent's proposal with
// Accept and Decline (ospeli/ospeli#148). Plain data and rules, no screen code: the view uses it, and
// the shell's "Waiting for your decision" (modules/screens.js) reads it to link to the right screen.
export const TITLES = { queue: 'Clinic queue', referrals: 'Waiting list', summary: 'Clinic day', templates: 'Templates' };
export function screensFor(role) {
  if (role === 'clinic-receptionist' || role === 'clinic-nurse') return ['queue', 'summary'];
  if (role === 'booking-clerk') return ['referrals', 'queue', 'summary', 'templates'];
  if (role === 'outpatient-manager') return ['summary', 'referrals', 'queue', 'templates'];
  return ['summary', 'queue', 'referrals', 'templates'];
}
// The screens whose card shows this proposal, best first. The queue, the waiting list and the clinic
// day each show every clinic proposal; the first screen is the one where its work is done: a step on
// the queue, a booking or a referral on the waiting list, a session change, move or cancel on the day.
// Templates are read-only and show none.
export function shownOn(p) {
  const c = p.command;
  if (!/^ospeli_(clinics|slots|codes)_/.test(c)) return [];
  if (/^ospeli_(slots_book|slots_reminder_|codes_)/.test(c)) return ['referrals', 'queue', 'summary'];
  if (/^ospeli_(slots_(move|cancel|session_|template_)|clinics_guide_)/.test(c)) return ['summary', 'referrals', 'queue'];
  return ['queue', 'summary', 'referrals'];
}
