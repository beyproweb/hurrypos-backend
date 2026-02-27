const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 60000);

async function runZReportOcr(filePath) {
  const scriptPath = path.join(__dirname, "..", "tools", "ocr_zreport.py");
  const preferredPython =
    process.env.OCR_PYTHON ||
    (fs.existsSync(
      "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3"
    )
      ? "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3"
      : "python3");

  return new Promise((resolve, reject) => {
    const systemPathPrefix = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const runtimePath = process.env.PATH
      ? `${systemPathPrefix}:${process.env.PATH}`
      : systemPathPrefix;
    const safeEnv = {
      ...process.env,
      PATH: runtimePath,
    };

    const proc = spawn(preferredPython, [scriptPath, filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnv,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        proc.kill("SIGKILL");
        reject(new Error("OCR timeout"));
      }
    }, OCR_TIMEOUT_MS);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      finished = true;
      reject(new Error(`OCR spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      finished = true;
      if (code !== 0) {
        let detail = stderr ? stderr.slice(0, 500) : "";
        if (!detail && stdout) {
          try {
            const parsed = JSON.parse(stdout || "{}");
            if (parsed.error) {
              detail = parsed.error;
            }
          } catch {
            detail = stdout.slice(0, 500);
          }
        }
        return reject(new Error(detail || "OCR process failed"));
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed.error) {
          return reject(new Error(parsed.error));
        }
        if (!parsed.text || !String(parsed.text).trim()) {
          return reject(new Error("OCR_EMPTY"));
        }
        resolve(parsed.text || "");
      } catch (err) {
        reject(new Error("OCR parse failed"));
      }
    });
  });
}

module.exports = { runZReportOcr };
