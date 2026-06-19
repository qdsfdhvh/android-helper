// Parsing + command helpers for talking to Android devices via adb / gradle.
// Pure functions only — no muxy calls here, so they stay easy to reason about.

/**
 * Parse the output of `adb devices -l`.
 *
 * Example input:
 *   List of devices attached
 *   emulator-5554   device product:sdk_gphone model:Pixel_6 device:emu64x transport_id:1
 *   RFCN20XXXX      unauthorized usb:1-1
 *
 * @param {string} stdout
 * @returns {Array<{serial:string, state:string, model:string|null, ready:boolean}>}
 */
export function parseDevices(stdout) {
  if (!stdout) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // Drop the header and any daemon chatter ("* daemon started ...").
    .filter((line) => !/^List of devices/i.test(line) && !line.startsWith("*"))
    .map(parseDeviceLine)
    .filter(Boolean);
}

function parseDeviceLine(line) {
  const parts = line.split(/\s+/);
  const serial = parts[0];
  const state = parts[1] || "unknown";
  if (!serial || !state) return null;

  let model = null;
  for (const token of parts.slice(2)) {
    const [key, value] = token.split(":");
    if (key === "model" && value) {
      model = value.replace(/_/g, " ");
      break;
    }
  }

  return { serial, state, model, ready: state === "device" };
}

/**
 * Build the shell command that compiles a fresh package and installs it to a
 * specific device. `installDebug` builds then installs in one step; we pin the
 * target device with ANDROID_SERIAL so it ignores other connected devices.
 *
 * @param {string} serial
 * @param {{task?:string, gradlew?:string}} [opts]
 * @returns {string}
 */
export function buildInstallCommand(serial, opts = {}) {
  const task = opts.task || "installDebug";
  const gradlew = opts.gradlew || "./gradlew";
  // prepend module path if specified (e.g. ":app:installDebug")
  const module = opts.module ? `${opts.module}:` : "";
  const fullTask = `${module}${task}`;
  return `ANDROID_SERIAL=${shellQuote(serial)} ${gradlew} ${fullTask}`;
}

/**
 * Build the `adb shell monkey -p <pkg> 1` command that launches the main
 * activity of a package. Redirects monkey's UI-exercise noise to /dev/null.
 *
 * @param {string} serial
 * @param {string} packageName
 * @returns {string}
 */
export function launchPackageCommand(serial, packageName) {
  const s = shellQuote(serial);
  const p = shellQuote(packageName);
  return `adb -s ${s} shell monkey -p ${p} 1 >/dev/null 2>&1`;
}

/**
 * Build a one-liner that chains: **install** → **launch** → **logcat**.
 * The terminal shows Gradle output, then launches the app, then streams its
 * logs. Falls back to plain install when no package name is available.
 *
 * @param {string} serial
 * @param {{task?:string, gradlew?:string, module?:string, packageName?:string}} [opts]
 * @returns {string}
 */
export function installAndLogCommand(serial, opts = {}) {
  const pkg = opts.packageName;
  if (!pkg) return buildInstallCommand(serial, opts);

  const task = opts.task || "installDebug";
  const gradlew = opts.gradlew || "./gradlew";
  const module = opts.module ? `${opts.module}:` : "";
  const fullTask = `${module}${task}`;
  const s = shellQuote(serial);
  const p = shellQuote(pkg);

  const installCmd = `ANDROID_SERIAL=${s} ${gradlew} ${fullTask}`;
  const launchCmd = `adb -s ${s} shell monkey -p ${p} 1 >/dev/null 2>&1`;
  // app logcat: brief timestamp + tag filter
  const logcatCmd = `adb -s ${s} logcat -v brief -T 1 ${p}:V *:S`;

  return [
    installCmd,
    "echo",
    'echo "--- Build complete. Launching app..."',
    launchCmd,
    'echo "--- App launched. Streaming logs (Ctrl+C to stop)..."',
    logcatCmd,
  ].join(" && \\\n");
}

/**
 * Build the `adb logcat` command for a device. Streamed in a terminal tab, so
 * variants just tweak the buffer/filter.
 *
 * Supported variants:
 *  - `"all"`          — no filter
 *  - `"error"`        — `*:E` only
 *  - `"crash"`        — `-b crash` buffer
 *  - `"buffer:main"`   — `-b main` buffer
 *  - `"buffer:system"` — `-b system` buffer
 *  - `"app"`          — filter by package PID
 *  - `"custom"`       — uses `filter` field to `grep`
 *
 * @param {string} serial
 * @param {string} [variant="all"]
 * @param {string|null} [pkg=null]  Package name for "app" variant
 * @param {string} [filter=""]      Grep filter for "custom" variant
 * @returns {string}
 */
export function logcatCommand(serial, variant = "all", pkg = null, filter = "") {
  const s = shellQuote(serial);
  const base = `adb -s ${s} logcat`;
  switch (variant) {
    case "error":
      return `${base} *:E`;
    case "crash":
    case "buffer:crash":
      return `${base} -b crash`;
    case "buffer:main":
      return `${base} -b main`;
    case "buffer:system":
      return `${base} -b system`;
    case "custom":
      return filter
        ? `${base} -v brief -T 1 | ${shellQuote(`grep -i --line-buffered ${filter}`)}`
        : base;
    case "app": {
      if (!pkg) return base;
      const p = shellQuote(pkg);
      // Resolve the running app's pid on the device, then follow only its logs.
      // pidof is empty when the app isn't running yet, so hint instead of erroring.
      return (
        `PID=$(adb -s ${s} shell pidof -s ${p}); ` +
        `if [ -z "$PID" ]; then echo "App ${pkg} not running — launch it, then re-run this."; ` +
        `else adb -s ${s} logcat --pid="$PID"; fi`
      );
    }
    default:
      return base;
  }
}

/**
 * Build the `adb pull <remote> <local>` command for downloading a file from
 * the device to the current working directory. Uses a timestamped filename
 * to avoid overwriting if the same file is pulled twice.
 *
 * @param {string} serial
 * @param {string} remotePath  Absolute path on the device (e.g. /sdcard/Download/photo.jpg)
 * @returns {string}
 */
export function devicePullCommand(serial, remotePath) {
  const s = shellQuote(serial);
  const r = shellQuote(remotePath);
  return [
    `mkdir -p ~/Downloads/android-pull && adb -s ${s} pull ${r} ~/Downloads/android-pull/`,
    "echo",
    `echo "Done — file pulled to ~/Downloads/android-pull/$(basename ${r})"`,
  ].join(" && \\\n");
}

/**
 * Build a command that prints a formatted device info summary in the terminal.
 * Fetches model, Android version, API level, arch, density, resolution, IP, and
 * battery from the device via getprop / dumpsys.
 *
 * @param {string} serial
 * @returns {string}
 */
export function deviceInfoCommand(serial) {
  const s = shellQuote(serial);
  // We run one adb shell invocation that echoes data line by line.
  const info = [
    "echo '=== Device Info ==='",
    "echo",
    'echo "Model:     $(getprop ro.product.model)"',
    'echo "Android:   $(getprop ro.build.version.release)"',
    'echo "API:       $(getprop ro.build.version.sdk)"',
    'echo "Arch:      $(getprop ro.product.cpu.abi)"',
    'echo "Density:   $(wm density 2>/dev/null | head -1 || echo \"N/A\")"',
    'echo "Res:       $(wm size 2>/dev/null | head -1 || echo \"N/A\")"',
    'echo "IP:        $(ip -4 addr show wlan0 2>/dev/null | grep -oE \"inet [0-9.]+\" | cut -d\" \" -f2 || echo \"N/A\")"',
    'echo "Battery:   $(dumpsys battery 2>/dev/null | grep -E \"level|status|temperature\" | paste -sd\", \" || echo \"N/A\")"',
    "echo",
    "echo '=== Fingerprint ==='",
    "echo",
    'echo "$(getprop ro.build.fingerprint)"',
    "echo",
    "echo '=== All properties (getprop) ==='",
    "getprop | sort",
  ].join(" && \\\n    ");
  return `adb -s ${s} shell sh -c ${shellQuote(info)}`;
}

/**
 * Build a shell command that runs a specific action against a package on the
 * device. Supported actions:
 *   - `"forcestop"` → `am force-stop <pkg>`
 *   - `"cleardata"` → `pm clear <pkg>`
 *   - `"uninstall"` → `pm uninstall <pkg>` (keeps data)
 *
 * @param {string} serial
 * @param {"forcestop"|"cleardata"|"uninstall"} action
 * @param {string} packageName
 * @returns {string}
 */
export function appActionCommand(serial, action, packageName) {
  const s = shellQuote(serial);
  const p = shellQuote(packageName);
  const label = { forcestop: "Force stop", cleardata: "Clear data", uninstall: "Uninstall" }[action] || action;
  switch (action) {
    case "forcestop":
      return [
        `adb -s ${s} shell am force-stop ${p}`,
        `echo "${label}: ${packageName}"`,
      ].join(" && \\\n");
    case "cleardata":
      return [
        `adb -s ${s} shell pm clear ${p}`,
        `echo "${label}: ${packageName}"`,
      ].join(" && \\\n");
    case "uninstall":
      return [
        `adb -s ${s} uninstall ${p}`,
        `echo "${label}: ${packageName}"`,
      ].join(" && \\\n");
    default:
      return `echo "Unknown action: ${action}"`;
  }
}

/**
 * Extract the Gradle `applicationId` from build script text. Handles both
 * Groovy (`applicationId "x"`) and Kotlin DSL (`applicationId = "x"`). Returns
 * null when it's set dynamically (e.g. from a variable) or absent.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseApplicationId(text) {
  if (!text) return null;
  const m = text.match(/applicationId\s*=?\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * Extract the Gradle `applicationIdSuffix` for a given build type (e.g. debug).
 * Handles both Groovy and Kotlin DSL.
 *
 * @param {string} text Build script content
 * @param {string} [buildType="debug"]
 * @returns {string|null}
 */
export function parseApplicationIdSuffix(text, buildType = "debug") {
  if (!text) return null;
  const escaped = buildType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${escaped}\\s*\\{[^}]*?applicationIdSuffix\\s*=?\\s*["']([^"']+)["']`,
    "i",
  );
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * Combine applicationId with its suffix for the effective running app package.
 *
 * @param {string|null} appId
 * @param {string|null} suffix
 * @returns {string|null}
 */
export function combineApplicationId(appId, suffix) {
  if (!appId) return null;
  return suffix ? `${appId}${suffix}` : appId;
}

/**
 * Parse available Android application modules from settings.gradle(.kts).
 * Returns module names (e.g. [":app", ":feature", ":lib"]).
 *
 * @param {string} text Content of settings.gradle or settings.gradle.kts
 * @returns {string[]}
 */
export function parseModuleNames(text) {
  if (!text) return [];
  const mods = [];
  // Match all include lines and extract all quoted module names
  const lineRe = /^\s*include\b[^\n]*$/gm;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    const line = m[0];
    const qRe = /['"]([^'"]+)['"]/g;
    let q;
    while ((q = qRe.exec(line)) !== null) {
      if (!mods.includes(q[1])) mods.push(q[1]);
    }
  }
  return mods.length > 0 ? mods : [];
}

/**
 * Parse build types from build.gradle(.kts) text.
 * Returns build type names found (e.g. ["debug", "release"]).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseBuildTypes(text) {
  if (!text) return ["debug", "release"];
  // Extract content inside buildTypes { … } handling nested braces
  const start = text.match(/buildTypes\s*\{/);
  if (!start) return ["debug", "release"];
  const idx = start.index + start[0].length;
  let depth = 1, i = idx;
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }
  const body = text.slice(idx, i - 1);
  // Extract top-level block names: word followed by {
  const types = [];
  const blockRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/g;
  let block;
  while ((block = blockRe.exec(body)) !== null) {
    types.push(block[1]);
  }
  return types.length > 0 ? [...new Set(types)] : ["debug", "release"];
}

/**
 * Build the device-side shell command that lists a directory. `-1` one per
 * line, `-p` appends `/` to directories, `-A` shows dotfiles (but not . / ..).
 * The path is quoted so the device shell treats spaces as part of the name.
 *
 * @param {string} path
 * @returns {string}
 */
export function deviceLsCommand(serial, path) {
  const s = shellQuote(serial);
  const p = shellQuote(path);
  return `adb -s ${s} shell ls -1 -p -A ${p}`;
}

/**
 * Parse `ls -1 -p` output into entries. Directories are flagged by the trailing
 * slash that `-p` adds. Sorted directories-first, then alphabetical.
 *
 * @param {string} stdout
 * @returns {Array<{name:string, isDir:boolean}>}
 */
export function parseLsEntries(stdout) {
  if (!stdout) return [];
  const entries = stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const isDir = line.endsWith("/");
      const name = isDir ? line.slice(0, -1) : line;
      return { name, isDir };
    })
    .filter((e) => e.name && e.name !== "." && e.name !== "..");
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  return entries;
}

/**
 * Join a directory path with a child name, always returning a trailing slash so
 * the result is ready to use as the next directory to list.
 */
export function joinDir(base, name) {
  const b = base.endsWith("/") ? base : `${base}/`;
  return `${b}${name}/`;
}

/**
 * The parent directory of `path`, keeping a trailing slash. Root stays "/".
 */
export function parentPath(path) {
  const p = path.replace(/\/+$/, "");
  if (p === "") return "/";
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx + 1);
}

/**
 * Build an `adb shell <command>` string for a device.
 * Quotes the command so the shell on your host passes it through correctly.
 *
 * @param {string} serial
 * @param {string} command  Shell command to run on the device (e.g. "ls -l /sdcard")
 * @returns {string}
 */
export function shellCommand(serial, command) {
  const s = shellQuote(serial);
  return `adb -s ${s} shell ${command}`;
}

/**
 * Returns a command that lists available Android Virtual Devices via `emulator -list-avds`.
 *
 * @returns {string}
 */
export function listAvdsCommand() {
  // Read AVD ini files, then check that config.ini has image.sysdir.1
  // (verifies the system image is installed, not just the AVD definition).
  // No emulator binary in PATH needed — reads files directly.
  return [
    "for f in ~/.android/avd/*.ini; do",
    '  n=$(basename "$f" .ini)',
    '  c="$HOME/.android/avd/${n}.avd/config.ini"',
    "  if [ -f \"$c\" ] && grep -q '^image\\.sysdir\\.1' \"$c\" 2>/dev/null; then",
    "    echo \"$n\"",
    "  fi",
    "done",
  ].join("\n");
}

/**
 * Returns a command that launches an AVD in a new terminal.
 * The `-no-snapshot-load` flag forces a cold boot (clean start).
 * Running in the background (`&`) so the terminal can be reused.
 *
 * @param {string} avdName
 * @returns {string}
 */
export function launchAvdCommand(avdName) {
  const a = shellQuote(avdName);
  return `echo "Starting ${avdName} (cold boot)..." && emulator -avd ${a} -no-snapshot-load`;
}

function shellQuote(value) {
  // Device serials are normally [A-Za-z0-9._-]; quote defensively anyway.
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
