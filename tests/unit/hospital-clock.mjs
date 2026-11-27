// Shared unit-test helper (ospeli/ospeli#133, point 3): load the example hospital with the test's
// clock held still.
//
// Many unit tests give the core a clock that moves one second each time it is asked. Storing the
// example hospital asks the clock about twice per event, so a ticking clock ran about 10 hours past
// the hospital's end time by the time the load was done, and a little further each time a module
// added synthetic history. A measure over a sliding window ("the last 7 days") then counted a
// different set of events, and a test failed by one for a reason that had nothing to do with it.
//
// loadHospital holds the clock at one reading while the hospital is stored (every record of the
// load is stamped with that one moment), then gives the test its own clock back, so the test
// starts one tick after the hospital's end time however much history the modules add. Only the
// test's clock is changed; the app's code is not.
import { loadSyntheticHospital } from '../../web/app/core/generator.js';

export async function loadHospital(core, options) {
  const tick = core.clock;
  let at;
  core.clock = () => (at ??= tick());
  try {
    return await loadSyntheticHospital(core, options);
  } finally {
    core.clock = tick;
  }
}
