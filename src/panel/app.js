import {
  appActionCommand,
  buildInstallCommand,
  combineApplicationId,
  deviceInfoCommand,
  deviceLsCommand,
  devicePullCommand,
  installAndLogCommand,
  joinDir,
  logcatCommand,
  parentPath,
  parseApplicationId,
  parseApplicationIdSuffix,
  parseBuildTypes,
  parseDevices,
  parseLsEntries,
  shellCommand,
} from "@/lib/adb";
import { clear, h } from "@/lib/dom";
import { icon } from "@/lib/icons";

const ROOT_PATH = "/sdcard/";

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function installTaskName(buildType) {
  return `install${capitalize(buildType)}`;
}

function fallbackLogcatPrompt(context, device, items) {
  const msg = items
    .map((i) => `${i.id}: ${i.title} (${i.subtitle})`)
    .join("\n");
  const choice = prompt(
    `Logcat options for ${device.model || device.serial}:\n${msg}\n\nType the option id:`,
  );
  if (choice && items.some((i) => i.id === choice)) {
    const pkg =
      choice === "app"
        ? context.state.appIdDebug || context.state.appId
        : null;
    muxy.tabs.open({
      kind: "terminal",
      command: logcatCommand(device.serial, choice, pkg),
    });
  }
}
export class DeviceListPanel {
  constructor(root) {
    this.root = root;
    this.state = {
      // devices
      status: "loading", // "loading" | "ready" | "error"
      devices: [],
      error: null,
      // selection + file browser
      selected: null, // serial
      path: ROOT_PATH,
      fsStatus: "idle", // "idle" | "loading" | "ready" | "error"
      entries: [],
      fsError: null,
      // current project's app id (for "this app" logcat filter)
      appId: null,
      appIdDebug: null, // appId + debug suffix (effective debug package)
      appIdRelease: null, // appId + release suffix
      buildTypes: ["debug", "release"], // detected build types
      modules: [], // detected modules (empty = root project, no prefix)
      shellInput: "", // adb shell input text
    };
  }

  start() {
    muxy.events.subscribe("command.refresh-devices", () => this.loadDevices());
    this.render();
    this.loadDevices();
    this.detectAppId();
  }

  async detectAppId() {
    // Best-effort read of the Gradle applicationId from the active project.
    // Failure just hides the "this app" option — never blocks anything.
    try {
      const acmd =
        "grep -hRoE 'applicationId[[:space:]]*=?[[:space:]]*\"[^\"]+\"' " +
        "--include=build.gradle --include=build.gradle.kts . 2>/dev/null | head -n1";
      const res = await muxy.exec(["sh", "-c", acmd]);
      const appId = parseApplicationId(res?.stdout ?? "");
      if (appId) {
        const text = res?.stdout ?? "";
        // Read full build.gradle content for additional info
        const suffixes = ["build.gradle", "build.gradle.kts"];
        for (const f of suffixes) {
          try {
            const full = await muxy.files.read(f);
            if (full && full.length > 20) {
              const buildTypes = parseBuildTypes(full);
              const debugSuffix = parseApplicationIdSuffix(full, "debug");
              const releaseSuffix = parseApplicationIdSuffix(full, "release");
              this.setState({
                appId,
                appIdDebug: combineApplicationId(appId, debugSuffix),
                appIdRelease: combineApplicationId(appId, releaseSuffix),
                buildTypes,
              });
              break;
            }
          } catch {/* ignore */}
        }
        this.setState({ appId });
      }
    } catch {
      /* ignore */
    }

  }

  // ---- devices ----------------------------------------------------------

  async loadDevices() {
    this.setState({ status: "loading", error: null });
    try {
      const result = await muxy.exec(["adb", "devices", "-l"]);
      const devices = parseDevices(result?.stdout ?? "");
      if (!devices.length && result?.stderr) {
        this.setState({ status: "error", error: result.stderr.trim(), devices: [] });
        return;
      }
      // Keep the current selection only if it's still connected.
      const stillThere = devices.some((d) => d.serial === this.state.selected && d.ready);
      this.setState({
        status: "ready",
        devices,
        error: null,
        selected: stillThere ? this.state.selected : null,
      });
    } catch (err) {
      this.setState({
        status: "error",
        devices: [],
        selected: null,
        error: String(err?.message ?? err ?? "Failed to run adb"),
      });
    }
  }

  showDeviceInfo(device) {
    muxy.tabs.open({
      kind: "terminal",
      command: deviceInfoCommand(device.serial),
    });
  }

  showAppActions(device) {
    const pkg = this.state.appIdDebug || this.state.appId;
    if (!pkg) {
      muxy.notifications?.show?.({
        title: "No package detected",
        body: "Open an Android project to enable app actions.",
      });
      return;
    }
    muxy.modal.open({
      title: "App — " + pkg,
      placeholder: "Choose action…",
      items: [
        {
          id: "forcestop",
          title: "Force stop",
          subtitle: `adb shell am force-stop ${pkg}`,
        },
        {
          id: "cleardata",
          title: "Clear data",
          subtitle: `adb shell pm clear ${pkg}`,
        },
        {
          id: "uninstall",
          title: "Uninstall",
          subtitle: `adb uninstall ${pkg}`,
        },
      ],
      onSelect: (choice) => {
        if (!choice) return;
        muxy.tabs.open({
          kind: "terminal",
          command: appActionCommand(
            device.serial,
            choice.id,
            pkg,
          ),
        });
      },
    });
  }

  async install(device) {
    try {
      const buildTypes = this.state.buildTypes || ["debug", "release"];

      // Resolve the effective package name for this build type
      const pkgForBuildType = (bt) => {
        if (bt === "debug" && this.state.appIdDebug) return this.state.appIdDebug;
        if (bt === "release" && this.state.appIdRelease) return this.state.appIdRelease;
        return this.state.appId;
      };

      // Quick path: single build type, no picker needed
      if (buildTypes.length === 1) {
        const bt = buildTypes[0];
        await muxy.tabs.open({
          kind: "terminal",
          command: installAndLogCommand(device.serial, {
            task: installTaskName(bt),
            packageName: pkgForBuildType(bt),
          }),
        });
        return;
      }

      // Build picker items: build types + custom task option
      const items = buildTypes.map((bt) => ({
        id: bt,
        title: `install${capitalize(bt)}`,
        subtitle: pkgForBuildType(bt) || bt,
      }));
      items.push({
        id: "__custom__",
        title: "Custom task…",
        subtitle: "Type a Gradle task name (e.g. :androidApp:installDebug)",
      });

      const choice = await muxy.modal.open({
        title: "Build & Install",
        placeholder: "Search variant…",
        items,
      });
      if (!choice) return;

      if (choice.id === "__custom__") {
        const customTask = prompt("Enter Gradle task:");
        if (!customTask) return;
        await muxy.tabs.open({
          kind: "terminal",
          command: buildInstallCommand(device.serial, { task: customTask }),
        });
        return;
      }

      await muxy.tabs.open({
        kind: "terminal",
        command: installAndLogCommand(device.serial, {
          task: installTaskName(choice.id),
          packageName: pkgForBuildType(choice.id),
        }),
      });
    } catch (err) {
      muxy.notifications?.show?.({
        title: "Couldn't start install",
        body: String(err?.message ?? err),
      });
    }
  }

  runShellCommand(device) {
    const cmd = this.state.shellInput.trim();
    if (!cmd) return;
    this.setState({ shellInput: "" });
    muxy.tabs.open({
      kind: "terminal",
      command: shellCommand(device.serial, cmd),
    });
  }

  shellInput(hasDevice) {
    const dev = hasDevice ? this.selectedDevice() : null;
    return h(
      "div",
      {
        class: [
          "flex shrink-0 items-center gap-2 border-t border-border px-3 py-2",
          hasDevice ? "" : "opacity-40 pointer-events-none",
        ].join(" "),
      },
      h("span", { class: "shrink-0 text-[11px] font-medium text-muted-foreground" }, "$"),
      h("input", {
        type: "text",
        placeholder: hasDevice ? "adb shell …" : "Select a device to run shell commands",
        class:
          "flex-1 min-w-0 rounded border-0 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50",
        value: this.state.shellInput,
        oninput: (e) => this.setState({ shellInput: e.target.value }),
        onkeydown: (e) => {
          if (e.key === "Enter" && dev) {
            e.preventDefault();
            this.runShellCommand(dev);
          }
        },
      }),
    );
  }

  showLogcat(device) {
    const items = [];
    // Use the effective debug app ID (appId + suffix) for "This app only"
    const effectiveAppId = this.state.appIdDebug || this.state.appId;
    if (effectiveAppId) {
      items.push({
        id: "app",
        title: "This app only",
        subtitle: effectiveAppId,
      });
    }
    items.push(
      { id: "all", title: "All", subtitle: "All log levels" },
      { id: "error", title: "Only errors", subtitle: "*:E" },
      { id: "buffer:main", title: "Main buffer", subtitle: "-b main (default)" },
      { id: "buffer:system", title: "System buffer", subtitle: "-b system" },
      { id: "buffer:crash", title: "Crash buffer", subtitle: "-b crash" },
      { id: "custom", title: "Custom filter…", subtitle: "grep for a keyword" },
    );

    if (!window.muxy?.modal) {
      fallbackLogcatPrompt(this, device, items);
      return;
    }

    muxy.modal
      .open({
        title: "Logcat — " + (device.model || device.serial),
        placeholder: "Filter…",
        items,
      })
      .then((choice) => {
        if (!choice) return;
        if (choice.id === "custom") {
          const filter = prompt("Enter log filter keyword:");
          if (!filter) return;
          muxy.tabs.open({
            kind: "terminal",
            command: logcatCommand(
              device.serial,
              "custom",
              null,
              filter,
            ),
          });
          return;
        }
        const pkg =
          choice.id === "app" ? effectiveAppId : null;
        muxy.tabs.open({
          kind: "terminal",
          command: logcatCommand(device.serial, choice.id, pkg),
        });
      });
  }

  async openLogcat(device, variant) {
    try {
      const pkg = variant === "app" 
        ? (this.state.appIdDebug || this.state.appId)
        : null;
      await muxy.tabs.open({
        kind: "terminal",
        command: logcatCommand(device.serial, variant, pkg),
      });
    } catch (err) {
      muxy.notifications?.show?.({
        title: "Couldn't open logcat",
        body: String(err?.message ?? err),
      });
    }
  }

  selectDevice(device) {
    if (!device.ready) return;
    if (this.state.selected === device.serial) return;
    this.setState({ selected: device.serial, path: ROOT_PATH });
    this.loadFiles();
  }

  // ---- file browser -----------------------------------------------------

  navigate(path) {
    this.setState({ path });
    this.loadFiles();
  }

  async loadFiles() {
    const serial = this.state.selected;
    if (!serial) return;
    const path = this.state.path;
    this.setState({ fsStatus: "loading", fsError: null });
    try {
      const result = await muxy.exec(["adb", "-s", serial, "shell", deviceLsCommand(path)]);
      // Ignore a stale response if the user moved on while we were waiting.
      if (this.state.selected !== serial || this.state.path !== path) return;
      const stdout = result?.stdout ?? "";
      const stderr = (result?.stderr ?? "").trim();
      if (!stdout.trim() && stderr) {
        this.setState({ fsStatus: "error", entries: [], fsError: stderr });
        return;
      }
      this.setState({ fsStatus: "ready", entries: parseLsEntries(stdout), fsError: null });
    } catch (err) {
      if (this.state.selected !== serial || this.state.path !== path) return;
      this.setState({
        fsStatus: "error",
        entries: [],
        fsError: String(err?.message ?? err),
      });
    }
  }

  // ---- plumbing ---------------------------------------------------------

  selectedDevice() {
    return this.state.devices.find((d) => d.serial === this.state.selected) || null;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  render() {
    clear(this.root);
    this.root.appendChild(this.view());
  }

  // ---- views ------------------------------------------------------------

  view() {
    const hasBrowser = this.state.status === "ready" && this.state.selected;
    return h(
      "div",
      { class: "flex h-full flex-col" },
      this.devicesSection(hasBrowser),
      hasBrowser ? this.fileBrowser() : null,
      this.shellInput(hasBrowser),
    );
  }

  devicesSection(hasBrowser) {
    return h(
      "div",
      {
        class: hasBrowser
          ? "flex max-h-[45%] shrink-0 flex-col overflow-y-auto"
          : "flex min-h-0 flex-1 flex-col",
      },
      this.devicesHeader(),
      h("div", { class: hasBrowser ? "" : "min-h-0 flex-1 overflow-y-auto" }, this.devicesBody()),
    );
  }

  devicesHeader() {
    return h(
      "div",
      {
        class:
          "flex items-center gap-2 border-b border-border px-2.5 py-2 text-[14px] font-semibold text-foreground",
      },
      icon("smartphone", 14, "text-primary"),
      "Devices",
      h(
        "span",
        { class: "ml-auto font-mono text-[11px] font-normal text-muted-foreground" },
        this.state.status === "ready" ? String(this.state.devices.length) : "",
      ),
    );
  }

  devicesBody() {
    if (this.state.status === "loading") return message("Looking for devices…");
    if (this.state.status === "error") return this.errorView();
    if (!this.state.devices.length) {
      return message("No devices connected. Plug in a device or start an emulator, then Refresh.");
    }
    return h(
      "div",
      { class: "flex flex-col" },
      this.state.devices.map((d) => this.deviceRow(d)),
    );
  }

  deviceRow(device) {
    const ready = device.ready;
    const selected = this.state.selected === device.serial;
    return h(
      "div",
      {
        class: [
          "flex items-center gap-2.5 border-b border-border px-2.5 py-2",
          ready ? "cursor-pointer" : "",
          selected ? "bg-accent" : "hover:bg-accent",
        ]
          .filter(Boolean)
          .join(" "),
        onclick: ready ? () => this.selectDevice(device) : null,
      },
      statusDot(device.state),
      h(
        "div",
        { class: "flex min-w-0 flex-col" },
        h(
          "span",
          {
            class:
              "truncate text-[12px] text-foreground cursor-pointer hover:text-primary",
            onclick: (e) => {
              e.stopPropagation();
              this.showDeviceInfo(device);
            },
            title: "Show device info",
          },
          device.model || device.serial,
        ),
        h(
          "span",
          { class: "truncate font-mono text-[10px] text-muted-foreground" },
          ready ? device.serial : `${device.serial} · ${device.state}`,
        ),
      ),
      h(
        "div",
        { class: "ml-auto flex shrink-0 items-center gap-1.5" },
        h(
          "button",
          {
            type: "button",
            disabled: !ready,
            title: ready ? "View logcat" : `Device is ${device.state}`,
            class:
              "flex h-7 items-center gap-1.5 rounded-md bg-surface px-2.5 text-[12px] font-medium text-foreground outline-none hover:bg-accent disabled:opacity-40",
            onclick: ready
              ? (e) => {
                  e.stopPropagation();
                  this.showLogcat(device);
                }
              : null,
          },
          icon("logs", 13),
          "Log",
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !ready,
            title: ready
              ? "App actions (force stop, clear data)"
              : "",
            class:
              "flex h-7 w-7 items-center justify-center rounded-md bg-surface text-[15px] text-foreground outline-none hover:bg-accent disabled:opacity-40",
            onclick: ready
              ? (e) => {
                  e.stopPropagation();
                  if (
                    !this.state.appId &&
                    !this.state.appIdDebug
                  )
                    return;
                  this.showAppActions(device);
                }
              : null,
          },
          "⋯",
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !ready,
            title: ready ? "Build & install to this device" : `Device is ${device.state}`,
            class:
              "flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground outline-none transition-opacity hover:opacity-95 disabled:opacity-40",
            onclick: ready
              ? (e) => {
                  e.stopPropagation();
                  this.install(device);
                }
              : null,
          },
          icon("download", 13),
          "Install",
        ),
      ),
    );
  }

  fileBrowser() {
    const dev = this.selectedDevice();
    return h(
      "div",
      { class: "flex min-h-0 flex-1 flex-col border-t border-border" },
      h(
        "div",
        { class: "flex items-center gap-1.5 border-b border-border px-2.5 py-1.5" },
        h(
          "button",
          {
            type: "button",
            title: "Up",
            disabled: this.state.path === "/",
            class:
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-30",
            onclick: () => this.navigate(parentPath(this.state.path)),
          },
          icon("arrowUp", 13),
        ),
        h(
          "span",
          {
            class: "min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground",
            title: dev ? `${dev.model || dev.serial}: ${this.state.path}` : this.state.path,
          },
          this.state.path,
        ),
        h(
          "button",
          {
            type: "button",
            title: "Refresh listing",
            class:
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground",
            onclick: () => this.loadFiles(),
          },
          icon("refresh", 12),
        ),
      ),
      h("div", { class: "min-h-0 flex-1 overflow-y-auto" }, this.fsBody()),
    );
  }

  fsBody() {
    if (this.state.fsStatus === "loading") return message("Loading…");
    if (this.state.fsStatus === "error") {
      return h(
        "div",
        { class: "flex flex-col gap-2 p-3" },
        h(
          "div",
          { class: "flex items-center gap-1.5 text-[12px] font-medium text-foreground" },
          icon("alert", 14, "text-[var(--muxy-diff-remove)]"),
          "Can't read this folder",
        ),
        h(
          "pre",
          {
            class:
              "whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2 font-mono text-[11px] text-muted-foreground",
          },
          this.state.fsError || "Permission denied.",
        ),
      );
    }
    if (!this.state.entries.length) return message("Empty folder.");
    return h(
      "div",
      { class: "flex flex-col" },
      this.state.entries.map((e) => this.entryRow(e)),
    );
  }

  downloadFile(device, entry) {
    const remotePath = joinDir(this.state.path, entry.name);
    muxy.tabs.open({
      kind: "terminal",
      command: devicePullCommand(device.serial, remotePath),
    });
  }

  entryRow(entry) {
    const dev = this.selectedDevice();
    const isDir = entry.isDir;
    const actions = isDir
      ? { onclick: () => this.navigate(joinDir(this.state.path, entry.name)) }
      : {
          onclick: () => this.downloadFile(dev, entry),
          title: `adb pull ${joinDir(this.state.path, entry.name)}`,
        };
    return h(
      "div",
      {
        class: [
          "flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-foreground",
          "cursor-pointer hover:bg-accent",
        ]
          .filter(Boolean)
          .join(" "),
        ...actions,
      },
      icon(isDir ? "folder" : "file", 13, isDir ? "text-primary" : "text-muted-foreground"),
      h("span", { class: "truncate flex-1" }, entry.name),
      isDir
        ? null
        : h(
            "span",
            { class: "shrink-0 text-[10px] text-muted-foreground" },
            "download",
          ),
    );
  }

  errorView() {
    return h(
      "div",
      { class: "flex flex-col gap-2 p-3" },
      h(
        "div",
        { class: "flex items-center gap-1.5 text-[12px] font-medium text-foreground" },
        icon("alert", 14, "text-[var(--muxy-diff-remove)]"),
        "Couldn't list devices",
      ),
      h(
        "pre",
        {
          class:
            "whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2 font-mono text-[11px] text-muted-foreground",
        },
        this.state.error || "Make sure `adb` is installed and on your PATH.",
      ),
      h(
        "button",
        {
          type: "button",
          class:
            "flex h-7 w-fit items-center gap-1.5 rounded-md bg-surface px-2.5 text-[12px] text-foreground outline-none hover:bg-accent",
          onclick: () => this.loadDevices(),
        },
        icon("refresh", 13),
        "Retry",
      ),
    );
  }
}

function statusDot(state) {
  const color = state === "device" ? "var(--muxy-diff-add)" : "var(--muxy-diff-remove)";
  return h("span", {
    class: "h-2 w-2 shrink-0 rounded-full",
    style: `background:${color}`,
  });
}

function message(text) {
  return h("p", { class: "px-3 py-3 text-[12px] text-muted-foreground" }, text);
}
