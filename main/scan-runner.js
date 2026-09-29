// Runs the scan one at a time. Scans used to start independently from the
// interval, startup, the tray, Scan Now and every add-streamer, so two could
// overlap and the older one's results (read before a stream went live) would
// close a cell the newer one had just opened. Tested in
// test/main-scan-runner.test.js.

// task: async () => void. onError(err) is told about a scan that threw; the
// promises handed out here never reject, so fire-and-forget callers cannot
// raise unhandled rejections.
function createSingleFlight(task, onError = () => {}) {
  let inFlight = null;
  let followUp = null; // { promise, resolve }

  function start() {
    const run = Promise.resolve()
      .then(task)
      .catch((err) => {
        try { onError(err); } catch (e) { /* reporting must not break the chain */ }
      })
      .then(() => {
        inFlight = null;
        if (followUp) {
          const next = followUp;
          followUp = null;
          start().then(next.resolve);
        }
      });
    inFlight = run;
    return run;
  }

  return {
    get running() {
      return inFlight !== null;
    },

    // Scheduled scans: join the scan in progress rather than start another.
    run() {
      return inFlight || start();
    },

    // Scans a user asked for (Scan Now, the tray, adding a streamer). The scan
    // in progress may have read a platform before the user's action, so one
    // more runs after it; every request made meanwhile shares that one.
    // Resolves when a scan that started after the request has finished.
    runFresh() {
      if (!inFlight) return start();
      if (!followUp) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        followUp = { promise, resolve };
      }
      return followUp.promise;
    },
  };
}

module.exports = { createSingleFlight };
