import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, rmSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

interface DiagnosticFields {
  version?: string; onboarding?: boolean; sourceReady?: boolean; analysisStatus?: string; people?: number; topics?: number; reports?: number; stage?: string; current?: number; total?: number; code?: string; elapsedMs?: number; topicId?: string;
  pid?: number; executable?: string; userData?: string; cwd?: string; updatedLaunch?: boolean; agentLaunched?: boolean;
  fileKind?: string; filePath?: string; realPath?: string; size?: number; sha256?: string; device?: string; inode?: string; modifiedAt?: string;
  primaryLogCode?: string; primaryLogPath?: string; ready?: boolean; downloading?: boolean; installing?: boolean; waitingFor?: string;
}

const allowedFields = new Set(['version','onboarding','sourceReady','analysisStatus','people','topics','reports','stage','current','total','code','elapsedMs','topicId','pid','executable','userData','cwd','updatedLaunch','agentLaunched','fileKind','filePath','realPath','size','sha256','device','inode','modifiedAt','primaryLogCode','primaryLogPath','ready','downloading','installing','waitingFor']);
const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException)?.code || 'UNKNOWN').replace(/[^A-Z0-9_]/g, '').slice(0,64);

/** Metadata only. Never accepts exception messages, prompts, names or credentials. */
export class Diagnostics {
  readonly bootId = randomUUID();
  readonly file: string;
  readonly fallbackFile: string;
  constructor(directory: string, fallbackDirectory = path.join(os.tmpdir(), 'family-bridge-diagnostics')) {
    this.file = path.join(directory, "diagnostics", "lifecycle.jsonl");
    this.fallbackFile = path.join(fallbackDirectory, `process-${process.pid}-${this.bootId}.jsonl`);
  }
  private append(file: string, entry: object) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > 512_000) {
      const previous = `${file}.previous`;
      if (existsSync(previous)) rmSync(previous);
      renameSync(file, previous);
    }
    appendFileSync(file, JSON.stringify(entry) + '\n');
  }
  record(event: string, fields: DiagnosticFields = {}) {
    // Runtime allowlist: a caller cannot accidentally spread prompts or tokens.
    const safe = Object.fromEntries(Object.entries(fields).filter(([key,value]) => allowedFields.has(key) && ['string','number','boolean'].includes(typeof value)));
    const entry = { at: new Date().toISOString(), bootId: this.bootId, pid: process.pid, event, ...safe };
    let failure: string | undefined;
    try {
      this.append(this.file, entry);
    } catch (error) { failure = errorCode(error); }
    // Independent location, so profile/path failures do not erase all evidence.
    try { this.append(this.fallbackFile, { ...entry, ...(failure ? { primaryLogCode: failure, primaryLogPath: this.file } : {}) }); }
    catch { /* Diagnostics must never prevent startup. */ }
  }
  snapshotFile(fileKind: 'state' | 'source' | 'analysis', file: string, stage: string) {
    try {
      const bytes = readFileSync(file);
      const stat = statSync(file, { bigint: true });
      const fields: DiagnosticFields = { fileKind, stage, filePath: file, realPath: realpathSync(file), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), device: String(stat.dev), inode: String(stat.ino), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() };
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (fileKind === 'state') { fields.onboarding = value.onboardingComplete === true; fields.reports = Array.isArray(value.reports) ? value.reports.length : 0; }
        if (fileKind === 'analysis') { fields.analysisStatus = ['ready','analyzing','error'].includes(value.status) ? value.status : 'other'; fields.topics = Array.isArray(value.topics) ? value.topics.length : 0; fields.people = Array.isArray(value.people) ? value.people.length : 0; }
        if (fileKind === 'source') fields.sourceReady = value.status === 'ready';
      } catch { fields.code = 'INVALID_JSON'; }
      this.record('storage.file', fields);
    } catch (error) { this.record('storage.file', { fileKind, stage, filePath: file, code: errorCode(error) }); }
  }
  snapshotProfile(directory: string, stage: string) {
    this.snapshotFile('state', path.join(directory,'state.json'), stage);
    this.snapshotFile('source', path.join(directory,'psychologist-memory/context-source.json'), stage);
    this.snapshotFile('analysis', path.join(directory,'psychologist-memory/context-analysis.json'), stage);
  }
}
