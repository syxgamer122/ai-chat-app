'use strict';

/**
 * Job store cho lệnh shell chạy NỀN (bg_run/bg_status/bg_stop) — file-backed
 * dưới <userDataDir>/bg-jobs/: mỗi job một <id>.json (meta) + <id>.log
 * (stdout+stderr của process detached).
 *
 * Vì sao file thay vì Map trong bộ nhớ: process con spawn detached SỐNG SÓT
 * qua restart của server Next, nên meta phải nằm trên đĩa để bg_status sau
 * khi restart vẫn đọc được; pid chết sau restart được reconcile thành 'done'
 * (exit code không rõ — chỉ còn log).
 *
 * Thuần node fs, không phụ thuộc Electron/Tauri — test được với tmpdir.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Trần số job giữ trên đĩa — vượt thì bỏ job cũ nhất (meta + log). */
const MAX_JOBS = 50;

/** Trần số job ĐANG CHẠY đồng thời — chặn spam bg_run cạn tài nguyên. */
const MAX_RUNNING = 5;

function jobsDir(userDataDir) {
  return path.join(userDataDir, 'bg-jobs');
}

class BgJobStore {
  constructor(dir) {
    this.dir = dir;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  metaPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  logPath(id) {
    return path.join(this.dir, `${id}.log`);
  }

  newId() {
    return `bg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  create(meta) {
    this.ensureDir();
    const record = { status: 'running', exitCode: null, startedAt: Date.now(), ...meta };
    fs.writeFileSync(this.metaPath(record.id), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id, patch) {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    fs.writeFileSync(this.metaPath(id), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  list() {
    this.ensureDir();
    const out = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')));
      } catch {
        // Meta hỏng (ghi dở giữa chừng) — bỏ, không chết cả danh sách.
      }
    }
    out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return out;
  }

  runningCount() {
    return this.list().filter((j) => j.status === 'running').length;
  }

  /** Đuôi log cho bg_status — không có log/truncated job → ''. */
  readTail(id, chars) {
    try {
      const text = fs.readFileSync(this.logPath(id), 'utf8');
      return text.length > chars ? text.slice(-chars) : text;
    } catch {
      return '';
    }
  }

  /**
   * Recovery sau restart: job còn 'running' mà pid đã chết → chốt 'done' với
   * ghi chú (exit code thật không biết được nữa — chỉ còn log). `pidAlive`
   * do caller cung cấp (process.kill(pid, 0) trên host thật).
   */
  reconcile(pidAlive) {
    for (const job of this.list()) {
      if (job.status !== 'running' || typeof job.pid !== 'number') continue;
      let alive = false;
      try {
        alive = pidAlive(job.pid);
      } catch {
        alive = false;
      }
      if (!alive) {
        this.update(job.id, {
          status: 'done',
          note: 'Process đã kết thúc (trước khi app khởi động lại) — exit code không rõ, xem log.',
        });
      }
    }
  }

  /** Giữ tối đa `max` job mới nhất; job đang chạy không bao giờ bị đụng tới. */
  prune(max = MAX_JOBS) {
    const jobs = this.list();
    const droppable = jobs.filter((j) => j.status !== 'running').slice(Math.max(0, max - jobs.filter((j) => j.status === 'running').length));
    for (const job of droppable) {
      try {
        fs.rmSync(this.metaPath(job.id), { force: true });
        fs.rmSync(this.logPath(job.id), { force: true });
      } catch {
        // File đang bị khóa (Windows) — bỏ, lượt prune sau dọn tiếp.
      }
    }
  }
}

module.exports = { BgJobStore, jobsDir, MAX_JOBS, MAX_RUNNING };
