// The checks as they run: each is named, passes or fails, and fails as well when the app said something went
// wrong while it ran (an error in the page, a refused native call, a file the content policy kept out).
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `faults` gives what the app reported since it was last asked, as lines. `step(name, fn, { allow })` runs one
 * check: `fn` throws to fail it and may return something for the checks after it (a failed one gives null);
 * `allow` lists the reports that check is meant to cause.
 */
export function runner(label, faults) {
  const failed = [];
  let count = 0;
  const step = async (name, fn, { allow = [] } = {}) => {
    count++;
    let problem = null;
    let result;
    try {
      result = await fn();
    } catch (e) {
      problem = String(e && e.message ? e.message : e);
    }
    const said = await faults().catch((e) => [`the app could not be asked what went wrong: ${e}`]);
    const real = said.filter((line) => !allow.some((re) => re.test(line)));
    if (!problem && real.length) problem = `the app reported: ${real.join(' | ')}`;
    if (problem) {
      failed.push(`${label}: ${name}`);
      console.error(`FAIL  ${label}: ${name}\n      ${problem.slice(0, 1200)}`);
      return null;
    }
    console.warn(`pass  ${label}: ${name}`);
    return result === undefined || result === null ? true : result;
  };
  return { step, failed, count: () => count };
}

/** Throws unless `ok`. */
export function must(ok, what) {
  if (!ok) throw new Error(what);
}
