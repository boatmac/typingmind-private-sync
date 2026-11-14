import { sha256 } from "./codec";
import { Vault } from "./crypto";
import type { AppData } from "./data";
import { ApprovalRequired, type SyncOptions } from "./engine";
import type { ImmutableStore, LogView } from "./immutable-log";
import { LogReplica, ReplicaConflictError, type ReplicaSlot } from "./log-replica";
import { equal, validateHead, type Backup, type Head } from "./model";

type Archive = { head: Head; metadata: { created: string; label: string } };

export class ImmutableEngine {
  constructor(private replica: LogReplica, private data: AppData, private archives: ImmutableStore,
    private archiveSlot: ReplicaSlot, private vault: Vault, private dataset: string, private target: string) {}

  get reloadRequired(): boolean { return this.replica.reloadRequired; }

  private async finish(view: LogView, options: SyncOptions): Promise<string> {
    if (view.records === null) throw new ReplicaConflictError(view);
    const local = await this.data.snapshot();
    if (!equal(local, view.records) && (!options.approve || !await options.approve(local, view.records))) {
      throw new ApprovalRequired();
    }
    await this.replica.applyRemote(view, async () => true);
    return this.reloadRequired ? "Synced and verified. Reload TypingMind now before editing." :
      "Sync complete. Immutable commits verified; no local reload needed.";
  }

  async sync(options: SyncOptions = {}): Promise<string> {
    if (options.resolve) throw new Error("Immutable conflicts require reviewed per-version choices.");
    return this.finish(await this.replica.publishLocal(), options);
  }

  async resolve(view: LogView, choices: Record<string, string | null>, approve: () => Promise<boolean>,
    options: SyncOptions): Promise<string> {
    await this.replica.resolveReviewed(view, choices, approve);
    return this.finish(await this.replica.review(), options);
  }

  async probe(): Promise<string> {
    await this.replica.review();
    await this.archives.list();
    return "S3 listing verified; existing commits validated. Write access is checked on sync/backup; no test objects created.";
  }

  private async archive(id: string): Promise<Archive> {
    const text = await this.archives.get(id);
    if (text === null) throw new Error("Immutable backup is missing.");
    if (await sha256(text) !== id) throw new Error("Immutable backup content hash mismatch.");
    const decoded = await this.vault.open(text);
    const head = validateHead(decoded);
    if (head.dataset !== this.dataset) throw new Error("Backup belongs to another immutable dataset.");
    if (!decoded || typeof decoded !== "object" || !("archive" in decoded) ||
        !decoded.archive || typeof decoded.archive !== "object" ||
        !("created" in decoded.archive) || typeof decoded.archive.created !== "string" ||
        !Number.isFinite(Date.parse(decoded.archive.created)) ||
        !("label" in decoded.archive) || typeof decoded.archive.label !== "string") {
      throw new Error("Invalid immutable backup metadata.");
    }
    await this.data.validate(head.records);
    return { head, metadata: { created: decoded.archive.created, label: decoded.archive.label } };
  }

  async backup(label: string): Promise<string> {
    await this.replica.review();
    let id: string;
    let text: string;
    const saved = await this.archiveSlot.read();
    const resumed = saved !== undefined;
    if (resumed) {
      if (typeof saved !== "string") throw new Error("Corrupt pending immutable backup.");
      const pending = await this.vault.open(saved);
      if (!pending || typeof pending !== "object" ||
          !("format" in pending) || pending.format !== "tmps-archive-pending-v1" ||
          !("target" in pending) || pending.target !== this.target ||
          !("id" in pending) || typeof pending.id !== "string" ||
          !("text" in pending) || typeof pending.text !== "string") {
        throw new Error("Invalid pending backup target or format.");
      }
      id = pending.id;
      text = pending.text;
      if (await sha256(text) !== id) throw new Error("Pending backup hash mismatch.");
    } else {
      const records = await this.data.snapshot();
      await this.data.validate(records);
      text = await this.vault.seal({
        format: 1, dataset: this.dataset, records, deleted: [], backups: [],
        archive: { created: new Date().toISOString(), label: label.trim() || "Manual backup" },
      });
      id = await sha256(text);
      await this.archiveSlot.write(await this.vault.seal({
        format: "tmps-archive-pending-v1", target: this.target, id, text,
      }));
    }
    const existing = await this.archives.get(id);
    if (existing !== null && existing !== text) throw new Error("Immutable backup object was replaced.");
    if (existing === null) await this.archives.put(id, text);
    if (await this.archives.get(id) !== text) throw new Error("Backup readback failed; retry the pending backup.");
    await this.archiveSlot.write(undefined);
    return `${resumed ? "Pending backup completed; current data may be newer" : "Backup saved"}: ${id}`;
  }

  async list(): Promise<Backup[]> {
    await this.replica.review();
    const backups: Backup[] = [];
    for (const id of await this.archives.list()) {
      const archive = await this.archive(id);
      backups.push({ id, ...archive.metadata });
    }
    return backups.sort((a, b) => a.created < b.created ? -1 : a.created > b.created ? 1 :
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  async restore(id: string, approve: () => Promise<boolean>): Promise<string> {
    const { head } = await this.archive(id);
    await this.replica.restoreLocal(head.records, approve);
    return "Local restore verified. Reload now. Remote commits are unchanged; later sync publishes restored changes.";
  }

  async rollback(approve: () => Promise<boolean>): Promise<string> {
    await this.replica.rollback(approve);
    return "Local rollback verified. Reload now. Remote commits are unchanged.";
  }

  async exportLocal(): Promise<string> {
    const records = await this.data.snapshot();
    await this.data.validate(records);
    return this.vault.seal({ format: 1, dataset: "local-export", records, deleted: [], backups: [] });
  }

  async exportRollback(): Promise<string> {
    return this.vault.seal({
      format: 1, dataset: "local-rollback", records: await this.replica.recoverySnapshot(), deleted: [], backups: [],
    });
  }

  async importLocal(text: string, approve: () => Promise<boolean>): Promise<string> {
    const snapshot = validateHead(await this.vault.open(text));
    await this.replica.restoreLocal(snapshot.records, approve);
    return "Local import verified. Reload now. Remote commits are unchanged.";
  }
}
