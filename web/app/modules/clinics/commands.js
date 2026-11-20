// Outpatient clinics (area A1): configuration and content on the shared core.
//
// SKELETON, wired by the module crew lead on 19 Nov 2026 so the app loads while the module is
// built. The builder fills this file: KPIS, COMMANDS (ospeli_clinics_queue, _day_summary,
// _guide_set), seed, prepareExample. The lists below are a first cut and belong to the module:
// change words, services, stages and role lists with the Domain lead.
//
// Sessions, slots and appointments are the shared slot object's (core/slots.js, ospeli_slots_*);
// patient codes are the shared patient code object's (core/codes.js, ospeli_codes_*). This module
// writes no booking or code command of its own and no clinics.* event except its guide switch.

export const id = 'clinics';
export const PREFIX = 'ospeli_clinics_';
export const EVENT_PREFIX = 'clinics.';

// Example services: a pick list, not a standard. A clinic is a service at a place, never a person.
export const SERVICES = {
  'general-medicine': 'General medicine clinic',
  diabetes: 'Diabetes clinic',
  eye: 'Eye clinic',
  antenatal: 'Antenatal clinic',
};

export const SESSION_TYPES = [
  { id: 'clinic', word: 'Clinic', timed: true, placeTypes: ['department'], services: SERVICES,
    runByRoles: ['clinic-nurse'], planRoles: ['outpatient-manager'], bookRoles: ['booking-clerk', 'outpatient-manager'], stepRoles: ['clinic-receptionist', 'clinic-nurse'] },
];
export const SLOT_TYPES = { new: 'New', 'follow-up': 'Follow-up' };
// Minutes after the booked time before "did not attend" may be recorded. Example setting, not a standard.
export const NO_SHOW_GRACE_MINUTES = 15;

export const CODE_KINDS = [
  { id: 'outpatient-referral', word: 'Outpatient referral', services: SERVICES, sources: ['referral', 'walk-in'], placeTypes: ['department'],
    openRoles: ['booking-clerk', 'outpatient-manager'], stageRoles: ['booking-clerk', 'outpatient-manager'], closeRoles: ['booking-clerk', 'outpatient-manager'],
    stages: [{ id: 'referral.accepted', word: 'Referral accepted', after: [] }],
    openStage: 'referral.accepted' },
];

export const KPIS = [];
export const COMMANDS = [];
