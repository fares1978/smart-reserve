// Runs jobs one at a time, never in parallel, with a randomized pause
// between them. Two reasons for this, not one:
//  1. A single Playwright browser context should only do one thing at a
//     time anyway.
//  2. Firing bookings back to back is the single most bot-like pattern a
//     detection system looks for. Spacing them out like a person actually
//     would is just good engineering here, not an attempt to defeat anything.

class SerialQueue {
  constructor({ minDelayMs, maxDelayMs }) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.tail = Promise.resolve();
  }

  randomDelay() {
    const span = Math.max(0, this.maxDelayMs - this.minDelayMs);
    return this.minDelayMs + Math.floor(Math.random() * span);
  }

  // Adds a job (an async function) to the queue and returns a promise that
  // resolves with whatever the job returns, once it's actually run.
  enqueue(job) {
    const run = this.tail.then(async () => {
      const wait = this.randomDelay();
      await new Promise((resolve) => setTimeout(resolve, wait));
      return job();
    });
    // Keep the chain alive even if this particular job rejects, so one
    // failed booking doesn't wedge every booking after it.
    this.tail = run.catch(() => {});
    return run;
  }
}

module.exports = { SerialQueue };
