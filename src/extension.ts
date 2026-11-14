import { sha256, unpack } from "./codec";
import { Vault } from "./crypto";
import { BrowserData, BrowserState, BrowserStateSlot } from "./data";
import { Engine } from "./engine";
import { ConflictError, recordKey, type Records } from "./model";
import { binding, HttpStore, type Config } from "./provider";
import { ImmutableEngine } from "./immutable-engine";
import { ImmutableLog, type LogView } from "./immutable-log";
import { ImmutableS3Store } from "./immutable-s3";
import { LogReplica, ReplicaConflictError } from "./log-replica";

const configKey = "tmps:config";
const rootId = "typingmind-private-sync-root";

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function boot(): void {
  if (document.getElementById(rootId)) return;
  const host = document.createElement("div");
  host.id = rootId;
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; font: 14px system-ui, sans-serif; color: #eee; }
      button, input, select { font: inherit; }
      button { cursor: pointer; border: 1px solid #777; border-radius: 6px;
        background: #30343b; color: #fff; padding: 8px; }
      button:disabled { opacity: .5; cursor: default; }
      #launcher { position: fixed; bottom: 12px; right: 12px; z-index: 2147483646; }
      dialog { background: #202329; color: #eee; border: 1px solid #777; border-radius: 12px;
        width: min(620px, calc(100vw - 48px)); max-height: 85dvh; padding: 18px; }
      dialog::backdrop { background: #0009; }
      h2 { margin: 0 0 12px; font-size: 19px; }
      label { display: block; margin: 9px 0; }
      input:not([type=checkbox]), select { box-sizing: border-box; width: 100%; padding: 7px;
        background: #11151b; color: #fff; border: 1px solid #777; border-radius: 4px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
      p, pre { line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
      #status { border-left: 3px solid #e6b84a; padding: 9px; }
      .warning { color: #ffd68a; }
      small { color: #bbb; }
    </style>
    <button id="launcher" type="button">Private Sync</button>
    <dialog aria-label="TypingMind Private Sync">
      <h2>Private Sync - experimental v0.1</h2>
      <p class="warning">Export an official TypingMind backup first. Use a test browser profile
        and dedicated storage prefix. This is not a verified replacement for official sync.</p>
      <p id="status" role="status" aria-live="polite">Locked. Credentials are kept in memory only.</p>
      <p id="session-state" aria-live="polite"></p>
      <form id="settings" autocomplete="off">
        <label>Storage <select id="provider"><option value="webdav">WebDAV</option>
          <option value="s3">S3-compatible (path-style)</option></select></label>
        <label>Sync protocol <select id="protocol">
          <option value="snapshot">Snapshot (requires atomic conditional writes)</option>
          <option value="immutable">Immutable S3 log (experimental concurrent sync)</option></select></label>
        <div id="immutable-fields" hidden>
          <label>Shared dataset ID (same on every device)
            <input id="dataset" minlength="12" maxlength="128" pattern="[a-zA-Z0-9_-]+"
              placeholder="Generate once, then copy to every device"></label>
          <button id="new-dataset" type="button">Generate new dataset ID</button>
          <p class="warning">S3 only. Requires scoped listing and ordinary GET/PUT access plus browser CORS.
            No local service. Existing snapshots are not migrated. History is not pruned; limit 1000 commits.
            Test storage checks listing, not write support.</p>
        </div>
        <label>HTTPS endpoint (WebDAV base folder or S3 service endpoint)
          <input id="endpoint" type="url" required placeholder="https://nas.example/remote.php/dav/files/user/"></label>
        <label>Dedicated prefix <input id="prefix" required value="typingmind-private"></label>
        <div id="dav-fields">
          <label>WebDAV username <input id="username" autocomplete="off"></label>
          <label>WebDAV password / app password <input id="dav-password" type="password" autocomplete="new-password"></label>
        </div>
        <div id="s3-fields" hidden>
          <label>Bucket <input id="bucket"></label>
          <label>Region <input id="region" value="us-east-1"></label>
          <label>Access key ID <input id="access-key" autocomplete="off"></label>
          <label>Secret access key <input id="secret-key" type="password" autocomplete="new-password"></label>
          <label>Session token (optional) <input id="session-token" type="password" autocomplete="new-password"></label>
        </div>
        <label>Encryption passphrase (12+ characters; same on every device)
          <input id="passphrase" type="password" minlength="12" required autocomplete="new-password"></label>
        <label>Additional exact keys to exclude (one per line)
          <textarea id="exclusions" rows="3" style="width: 98%"></textarea></label>
        <label><input id="acknowledge" type="checkbox" required>
          I have a backup, disabled official/other sync, closed other TypingMind tabs,
          and will not edit during manual sync/restore.</label>
        <button id="connect" type="submit">Unlock / connect</button>
        <button id="edit-credentials" type="button">Change credentials / lock</button>
      </form>
      <small>Only endpoint settings and exclusions are saved. Credentials and passphrase
        must be entered after each reload. Preferences with nested credentials may still
        be included inside the encrypted snapshot.</small>
      <div class="actions">
        <button id="sync" type="button">Sync now</button>
        <button id="test" type="button">Test storage</button>
        <button id="backup" type="button">Create backup</button>
        <button id="list" type="button">Refresh backups</button>
      </div>
      <label><input id="auto" type="checkbox">Background upload every 60s while visible.
        Incoming changes and conflicts pause it for manual review.</label>
      <label>Remote backups <select id="backups"></select></label>
      <div class="actions">
        <button id="restore" type="button">Restore selected to this device</button>
        <button id="rollback" type="button">Restore local rollback</button>
      </div>
      <div class="actions">
        <button id="export" type="button">Download encrypted local backup</button>
        <button id="export-rollback" type="button">Download local rollback</button>
        <button id="import" type="button">Restore encrypted backup file</button>
        <input id="file" type="file" accept=".json,application/json" hidden>
      </div>
      <p class="warning">Incoming writes require a reload before further use.
        Conflicts stop sync; neither side is silently overwritten.</p>
      <div id="conflicts" hidden>
        <pre id="conflict-keys"></pre>
        <button id="prefer-local" type="button">Retry: keep local conflicting records</button>
        <button id="prefer-remote" type="button">Retry: keep remote conflicting records</button>
      </div>
      <div id="log-conflicts" hidden>
        <p>Choose one version for each record. Deleted versions remove the record.
          All original encrypted commits remain in history.</p>
        <div id="log-versions"></div>
        <button id="resolve-log" type="button">Resolve selected versions and sync</button>
      </div>
      <div class="actions">
        <button id="reload" type="button">Reload app</button>
        <button id="lock" type="button">Lock / forget session credentials</button>
        <button id="close" type="button">Close</button>
      </div>
    </dialog>`;

  const element = <T extends HTMLElement>(id: string) => {
    const value = root.getElementById(id);
    if (!value) throw new Error(`Missing Private Sync UI element: ${id}`);
    return value as T;
  };
  const input = (id: string) => element<HTMLInputElement>(id);
  const value = (id: string) => input(id).value;
  const dialog = root.querySelector("dialog")!;
  const status = (message: string, error = false) => {
    element("status").textContent = message;
    element("launcher").textContent = error ? "Private Sync - attention" : "Private Sync";
  };
  let engine: Engine | ImmutableEngine | undefined;
  let provider: HttpStore | undefined;
  let reviewedConflict: LogView | undefined;
  const versionSelectors = new Map<string, HTMLSelectElement>();
  let busy = false;
  let needsReload = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const secretIds = ["dav-password", "access-key", "secret-key", "session-token", "passphrase"] as const;
  const updateControls = () => {
    const unlocked = engine !== undefined;
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      "input, select, textarea, button")) {
      if (control.id !== "close") control.disabled = busy;
    }
    for (const id of ["sync", "test", "backup", "list", "restore", "rollback", "export",
      "export-rollback", "import", "auto", "backups", "file", "prefer-local", "prefer-remote", "resolve-log"]) {
      element<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(id).disabled = busy || !unlocked;
    }
    for (const id of secretIds) {
      input(id).disabled = busy || unlocked;
      input(id).placeholder = unlocked ? "Kept in memory for this session" : "";
    }
    element<HTMLButtonElement>("connect").disabled = busy || unlocked;
    element<HTMLButtonElement>("edit-credentials").disabled = busy || !unlocked;
    element("session-state").textContent = (unlocked
      ? "Session unlocked. Secret fields are intentionally empty; credentials remain in memory. Use Change credentials / lock to edit them."
      : "Session locked. Enter settings and credentials, confirm the checklist, then click Unlock / connect.") +
      (needsReload ? " Reload TypingMind before further sync or restore operations." : "");
  };
  const stop = () => {
    input("auto").checked = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const clearConflicts = () => {
    reviewedConflict = undefined;
    versionSelectors.clear();
    element("conflicts").hidden = true;
    element("log-conflicts").hidden = true;
    element("log-versions").replaceChildren();
  };
  const forgetSession = () => {
    engine = undefined;
    provider = undefined;
    clearConflicts();
    updateControls();
  };
  const previewVersion = async (text: string | null): Promise<string> => {
    if (text === null) return "This version deletes the record.";
    const decoded = await unpack(text);
    const preview = JSON.stringify(decoded, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString() + "n";
      if (value instanceof Blob) return `[${value instanceof File ? value.name : "Blob"}: ${value.size} bytes]`;
      if (value instanceof Map) return [...value];
      if (value instanceof Set) return [...value];
      return value;
    }, 2) ?? String(decoded);
    return preview.length > 2000 ? preview.slice(0, 2000) + "\n[Preview truncated; full version remains encrypted.]" : preview;
  };
  const report = async (error: unknown) => {
    stop();
    console.error("[Private Sync]", error instanceof ReplicaConflictError ? error.message : error);
    status(error instanceof Error ? error.message : String(error), true);
    if (error instanceof ConflictError) {
      clearConflicts();
      element("conflicts").hidden = false;
      element("conflict-keys").textContent = error.conflicts.map(({ id, localDeleted, remoteDeleted }) =>
        `${recordKey(id).join(": ")} [local ${localDeleted ? "deleted" : "edited"}, remote ${remoteDeleted ? "deleted" : "edited"}]`).join("\n");
    }
    if (error instanceof ReplicaConflictError) {
      clearConflicts();
      reviewedConflict = error.view;
      element("log-conflicts").hidden = false;
      for (const conflict of error.view.conflicts) {
        const label = document.createElement("label");
        label.textContent = recordKey(conflict.id).join(": ");
        const select = document.createElement("select");
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose a version...";
        select.append(placeholder);
        const preview = document.createElement("pre");
        for (const [index, version] of conflict.versions.entries()) {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `Version ${index + 1} ${version.value === null ? "(deleted)" : "(edited)"} - ` +
            version.commits.map((id) => id.slice(0, 10)).join(", ");
          select.append(option);
        }
        select.onchange = () => {
          const selected = select.value;
          const version = conflict.versions[Number(select.value)];
          if (select.value === "" || !version) { preview.textContent = ""; return; }
          void previewVersion(version.value).then((text) => {
            if (select.value === selected && select.isConnected) preview.textContent = text;
          }, (failure: unknown) => {
            if (select.value !== selected || !select.isConnected) return;
            preview.textContent = "Cannot decode this version. Do not resolve; inspect the backup.";
            console.error("[Private Sync] Conflict preview failed.", failure);
          });
        };
        label.append(select, preview);
        element("log-versions").append(label);
        versionSelectors.set(conflict.id, select);
      }
    }
  };
  const run = async (action: () => Promise<string>): Promise<void> => {
    if (busy) { status("Another Private Sync operation is running.", true); return; }
    busy = true;
    updateControls();
    try {
      if (!navigator.locks) throw new Error("This browser must support the Web Locks API.");
      await navigator.locks.request("typingmind-private-sync", { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another tab is syncing. Close other TypingMind tabs and retry.");
        status("Working. Do not edit or close this tab...");
        status(await action());
        if (engine?.reloadRequired) { needsReload = true; stop(); }
      });
    } catch (error) {
      await report(error);
    } finally {
      busy = false;
      updateControls();
    }
  };
  const active = (): Engine | ImmutableEngine => {
    if (!engine) throw new Error("Unlock with credentials and a passphrase first.");
    if (needsReload) throw new Error("Reload TypingMind now before further operations.");
    return engine;
  };
  const approve = async (before: Records, after: Records) => {
    const changed = Object.keys(after).filter((key) => before[key] !== after[key]).length;
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(after, key)).length;
    return window.confirm(`Apply ${changed} new/changed record(s) and ${removed} deletion(s) to this device?\n\nStop editing and close other TypingMind tabs. A local rollback is saved before writing. Reload immediately afterwards.`);
  };
  const restoreApproval = async () => window.confirm(
    "Replace this device's included data with the selected backup?\n\nOther TypingMind tabs must be closed. A local rollback is saved. Remote data is not changed by restore. Reload immediately afterwards.");
  const sync = (side?: "local" | "remote") => run(async () => {
    const result = await active().sync({
      approve,
      resolve: side ? async (conflicts) => {
        if (!window.confirm(`Keep the ${side} version of ${conflicts.length} conflicting record(s), including any deletions?\nThe other version is protected by a pre-sync backup/rollback.`)) {
          throw new Error("Conflict resolution cancelled.");
        }
        return side;
      } : undefined,
    });
    clearConflicts();
    return result;
  });

  const switchFields = () => {
    element("dav-fields").hidden = value("provider") !== "webdav";
    element("s3-fields").hidden = value("provider") !== "s3";
    element("immutable-fields").hidden = value("protocol") !== "immutable";
    input("dataset").required = value("protocol") === "immutable";
    input("dataset").minLength = value("protocol") === "immutable" ? 12 : 0;
    input("dataset").pattern = value("protocol") === "immutable" ? "[a-zA-Z0-9_-]+" : ".*";
  };
  element("provider").onchange = switchFields;
  element("protocol").onchange = switchFields;
  element("new-dataset").onclick = () => {
    stop();
    forgetSession();
    input("dataset").value = crypto.randomUUID();
    status("New dataset ID generated. Copy it to every device; unlock with credentials again.");
  };
  try {
    const saved: Partial<Config & { protocol: string; dataset: string }> = JSON.parse(localStorage.getItem(configKey) ?? "{}");
    for (const id of ["provider", "endpoint", "prefix", "username", "bucket", "region", "protocol", "dataset"] as const) {
      if (typeof saved[id] === "string") input(id).value = saved[id];
    }
    if (saved.exclusions) element<HTMLTextAreaElement>("exclusions").value = saved.exclusions.join("\n");
    switchFields();
  } catch (error) {
    void report(new Error("Cannot read saved Private Sync configuration. Re-enter settings.", { cause: error }));
  }

  element<HTMLFormElement>("settings").onsubmit = (event) => {
    event.preventDefault();
    stop();
    void run(async () => {
      if (needsReload) throw new Error("Reload before changing connections.");
      if (!input("acknowledge").checked) throw new Error("Confirm the backup/sync safety checklist first.");
      forgetSession();
      const type = value("provider");
      if (type !== "webdav" && type !== "s3") throw new Error("Unknown provider.");
      const config: Config = {
        provider: type, endpoint: value("endpoint").trim(), prefix: value("prefix").trim(),
        bucket: value("bucket").trim(), region: value("region").trim(),
        username: value("username"),
        exclusions: value("exclusions").split("\n").map((key) => key.trim()).filter(Boolean),
      };
      const secrets = {
        password: value("dav-password"), accessKeyId: value("access-key"),
        secretAccessKey: value("secret-key"), sessionToken: value("session-token"),
      };
      const protocol = value("protocol");
      const dataset = value("dataset").trim();
      const vault = new Vault(value("passphrase"));
      const data = new BrowserData(indexedDB, localStorage, config.exclusions);
      let nextEngine: Engine | ImmutableEngine;
      let nextProvider: HttpStore | undefined;
      if (protocol === "immutable") {
        if (type !== "s3") throw new Error("Immutable log mode requires S3-compatible storage, not WebDAV.");
        if (!/^[a-zA-Z0-9_-]{12,128}$/.test(dataset)) throw new Error("Set the same shared dataset ID on every device.");
        const target = JSON.stringify(["immutable", binding(config), dataset]);
        const stateKey = await sha256(target);
        const commits = new ImmutableS3Store(config, secrets);
        const archives = new ImmutableS3Store(config, secrets, undefined, "backups");
        const replica = new LogReplica(new ImmutableLog(commits, vault, dataset), data,
          new BrowserStateSlot(indexedDB, "immutable:" + stateKey), vault, target, dataset, navigator.locks);
        nextEngine = new ImmutableEngine(replica, data, archives,
          new BrowserStateSlot(indexedDB, "immutable-archives:" + stateKey), vault, dataset, target);
      } else if (protocol === "snapshot") {
        nextProvider = new HttpStore(config, secrets);
        nextEngine = new Engine(nextProvider, data,
          new BrowserState(indexedDB, await sha256(binding(config))), vault);
      } else throw new Error("Unknown sync protocol.");
      localStorage.setItem(configKey, JSON.stringify({ ...config, protocol, dataset }));
      provider = nextProvider;
      engine = nextEngine;
      for (const id of secretIds) input(id).value = "";
      clearConflicts();
      return "Unlocked. No app data changed. Test storage, then run manual sync.";
    });
  };
  element<HTMLFormElement>("settings").oninput = () => {
    if (!engine || busy) return;
    stop();
    forgetSession();
    status("Settings changed. Session locked; re-enter credentials and unlock before any operation.");
  };

  element("launcher").onclick = () => dialog.showModal();
  element("close").onclick = () => dialog.close();
  element("reload").onclick = () => {
    if (!busy && window.confirm("Reload TypingMind? Wait for any model response to finish first.")) location.reload();
  };
  const lockSession = () => {
    if (busy) { status("Wait for the running operation before locking.", true); return; }
    stop();
    forgetSession();
    for (const id of secretIds) input(id).value = "";
    status(needsReload ? "Locked. Reload required before continuing." :
      "Locked. Session credentials discarded. Re-enter credentials and click Unlock / connect.");
  };
  element("lock").onclick = lockSession;
  element("edit-credentials").onclick = lockSession;
  element("sync").onclick = () => { void sync(); };
  element("prefer-local").onclick = () => { void sync("local"); };
  element("prefer-remote").onclick = () => { void sync("remote"); };
  element("resolve-log").onclick = () => { void run(async () => {
    const session = active();
    if (!(session instanceof ImmutableEngine) || !reviewedConflict) throw new Error("Sync to review current immutable conflicts first.");
    const choices: Record<string, string | null> = {};
    for (const conflict of reviewedConflict.conflicts) {
      const selected = versionSelectors.get(conflict.id)?.value;
      const version = selected === undefined || selected === "" ? undefined : conflict.versions[Number(selected)];
      if (!version) throw new Error("Choose a version for every conflict before resolving.");
      choices[conflict.id] = version.value;
    }
    const result = await session.resolve(reviewedConflict, choices, async () => window.confirm(
      "Publish the selected versions, including deletions?\nOriginal versions remain encrypted in history. Incoming changes still require approval."),
    { approve });
    clearConflicts();
    return result;
  }); };
  element("test").onclick = () => { void run(async () => {
    const session = active();
    if (session instanceof ImmutableEngine) return session.probe();
    await provider!.probe();
    return "Storage verified: authentication, strong ETags, conditional create/update, and probe cleanup.";
  }); };
  element("backup").onclick = () => { void run(() => active().backup("Manual backup")); };
  element("list").onclick = () => { void run(async () => {
    const backups = await active().list();
    const select = element<HTMLSelectElement>("backups");
    select.replaceChildren(...backups.slice().reverse().map((backup) => {
      const option = document.createElement("option");
      option.value = backup.id;
      option.textContent = `${backup.created} - ${backup.label}`;
      return option;
    }));
    return `${backups.length} remote backup(s).`;
  }); };
  element("restore").onclick = () => { void run(() => active().restore(value("backups"), restoreApproval)); };
  element("rollback").onclick = () => { void run(() => active().rollback(restoreApproval)); };
  element("export").onclick = () => { void run(async () => {
    if (!engine) throw new Error("Unlock first.");
    download(await engine.exportLocal(), `typingmind-local-${Date.now()}.json`);
    return "Encrypted local backup downloaded. Keep the passphrase separately.";
  }); };
  element("export-rollback").onclick = () => { void run(async () => {
    if (!engine) throw new Error("Unlock first.");
    download(await engine.exportRollback(), `typingmind-rollback-${Date.now()}.json`);
    return "Encrypted local rollback downloaded.";
  }); };
  element("import").onclick = () => input("file").click();
  input("file").onchange = () => { void run(async () => {
    const file = input("file").files?.[0];
    if (!file) throw new Error("No backup file selected.");
    const text = await file.text();
    input("file").value = "";
    return active().importLocal(text, restoreApproval);
  }); };
  input("auto").onchange = () => {
    const enabled = input("auto").checked;
    stop();
    if (!enabled) { status("Background sync disabled."); return; }
    try {
      active();
      input("auto").checked = true;
      timer = setInterval(() => {
        if (document.visibilityState !== "visible" || busy) return;
        void run(() => active().sync());
      }, 60_000);
      status("Background upload enabled for this session. Incoming changes pause for manual review.");
    } catch (error) {
      void report(error);
    }
  };
  updateControls();
}

if (typeof window !== "undefined" && !new URLSearchParams(location.search).has("safe_mode")) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
