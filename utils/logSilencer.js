// utils/logSilencer.js
// Global log silencer for production environments
// Silences console.log, console.debug, console.info in production
// Preserves console.warn and console.error in all environments

function setupLogSilencer() {
  const NODE_ENV = process.env.NODE_ENV || "development";
  const isProduction = NODE_ENV === "production";

  if (!isProduction) {
    // Development: keep all logs
    return;
  }

  // Production: silence noisy logs, keep warnings and errors
  const noop = () => {};

  console.log = noop;
  console.debug = noop;
  console.info = noop;

  // console.warn and console.error are preserved
}

module.exports = { setupLogSilencer };
