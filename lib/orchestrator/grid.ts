/**
 * Broadcast / parameter grid — port LÕI của vectorbt sang TypeScript.
 *
 * Ở vectorbt, ý tưởng quyết định tốc độ là: **đừng lặp**. Thay vì chạy từng
 * cấu hình chiến lược một, nó gấp toàn bộ không gian tham số vào **chiều cột**
 * của một ma trận (hàng = thời gian, cột = một cấu hình). `run_combs(..., r=2)`
 * sinh ra tích Descartes của các trục tham số, rồi mọi indicator/signal/
 * portfolio được tính bằng một phép toán trên TOÀN BỘ mảng.
 *
 * Chuyển ngữ sang orchestrator của Vyen:
 *   - "thời gian"      → không còn (không phải backtest).
 *   - "cột = cấu hình" → **một cell trong lưới tham số** (vd: góc tiếp cận
 *                        = phản biện × độ chi tiết = chi tiết).
 *   - "broadcast"      → gắn cùng một goal/context vào từng cell.
 *   - "MultiIndex"     → `coords` (tên trục → giá trị) + `key` để group by.
 *
 * Lõi này CỐ TÌNH không mang theo phần nặng của vectorbt (NumPy, Numba, Rust,
 * pandas accessor) — thứ chúng ta mượn là **hình dạng dữ liệu**, không phải
 * engine tính toán. Zero dependency, thuần function, test được trong node.
 */

/* ------------------------------------------------------------------ */
/* Kiểu                                                                */
/* ------------------------------------------------------------------ */

/** Một trục tham số — tương đương một level của MultiIndex trong vectorbt. */
export interface Axis {
  /** Tên trục, ví dụ: 'góc tiếp cận'. Dùng làm key group-by. */
  name: string;
  /** Các mức của trục. Đã trim, đã khử trùng, giữ nguyên thứ tự. */
  values: string[];
}

/**
 * MỘT cấu hình = một "cột" trong ma trận vectorbt.
 * `index` là vị trí cột (ổn định, dùng để nối kết quả về đúng cell).
 */
export interface Cell {
  index: number;
  /** Tên trục → giá trị của cell này. */
  coords: Record<string, string>;
  /** Khoá gom nhóm ổn định: nối giá trị theo thứ tự trục. */
  key: string;
}

export interface Grid {
  axes: Axis[];
  cells: Cell[];
}

/* ------------------------------------------------------------------ */
/* Ngưỡng                                                              */
/* ------------------------------------------------------------------ */

/**
 * Trần số cấu hình mặc định. Mỗi cell = MỘT lượt gọi LLM, nên đây là trần
 * CHI PHÍ chứ không phải trần bộ nhớ. 6 là điểm cân bằng: đủ rộng để heatmap
 * có hình (2 trục × 3×2), đủ hẹp để không đốt ngân sách gateway free.
 */
export const MAX_CELLS_DEFAULT = 6;

/** Trần cứng — chặn request cố tình hoặc planner sinh lưới điên. */
export const MAX_CELLS_LIMIT = 24;

export const MAX_AXES = 3;
export const MAX_VALUES_PER_AXIS = 12;

/* ------------------------------------------------------------------ */
/* Chuẩn hoá                                                           */
/* ------------------------------------------------------------------ */

const SEP = '|';

/** Cắt khoảng trắng, bỏ rỗng, khử trùng (giữ lần xuất hiện đầu). */
function cleanValues(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const t = v.trim().slice(0, 120);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Chuẩn hoá danh sách trục do LLM sinh ra (hoặc do người dùng nhập).
 * Rác → bỏ. Trùng tên trục → giữ trục đầu, gộp giá trị (LLM hay lặp tên).
 */
export function normalizeAxes(input: readonly unknown[]): Axis[] {
  if (!Array.isArray(input)) return [];
  const byName = new Map<string, string[]>();

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 32) : '';
    if (!name) continue;
    const values = Array.isArray(o.values) ? cleanValues(o.values) : [];
    if (!values.length) continue;

    const existing = byName.get(name);
    if (existing) {
      for (const v of values) if (!existing.includes(v)) existing.push(v);
    } else {
      byName.set(name, values.slice(0, MAX_VALUES_PER_AXIS));
    }
    if (byName.size >= MAX_AXES) break;
  }

  return [...byName.entries()].map(([name, values]) => ({ name, values }));
}

/* ------------------------------------------------------------------ */
/* Lấy mẫu đều — cơ chế "cap" của lưới                                 */
/* ------------------------------------------------------------------ */

export function product(axes: readonly Axis[]): number {
  return axes.reduce((n, a) => n * Math.max(1, a.values.length), 1);
}

/**
 * Lấy `n` phần tử cách đều, LUÔN giữ phần tử đầu và cuối.
 * Dùng để thu nhỏ một trục khi tích vượt trần — deterministic (không random)
 * để cùng một plan luôn sinh cùng một lưới, test được và reproduce được.
 */
export function evenSample<T>(arr: readonly T[], n: number): T[] {
  if (n >= arr.length) return arr.slice();
  if (n <= 1) return [arr[0]];
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * Thu nhỏ lưới tới khi tích ≤ `maxCells` bằng cách CHIA ĐÔI trục đang dài
 * nhất. Chọn trục dài nhất (thay vì cắt ngẫu nhiên) để giữ lại nhiều trục
 * khác nhau nhất có thể — đúng tinh thần "broadcast" của vectorbt: chiều nào
 * cũng phải còn xuất hiện trong kết quả.
 */
export function shrinkAxes(axes: readonly Axis[], maxCells: number): Axis[] {
  const work: Axis[] = axes.map((a) => ({ name: a.name, values: a.values.slice() }));
  let guard = 0;
  while (product(work) > maxCells && guard++ < 512) {
    let target = -1;
    for (let i = 0; i < work.length; i++) {
      if (work[i].values.length <= 1) continue;
      if (target === -1 || work[i].values.length > work[target].values.length) target = i;
    }
    if (target === -1) break; // mọi trục chỉ còn 1 giá trị — không thu nhỏ được nữa
    const len = work[target].values.length;
    work[target].values = evenSample(work[target].values, Math.max(1, Math.ceil(len / 2)));
  }
  return work;
}

/* ------------------------------------------------------------------ */
/* Broadcast                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tích Descartes — "columns = one configuration" của vectorbt.
 * Thứ tự sinh: trục ngoài cùng quay CHẬM nhất (giống `reshape` của NumPy,
 * `order='C'`), để index có thể dựng lại coords mà không cần lưu mảng.
 */
export function cartesian(axes: readonly Axis[]): Cell[] {
  const usable = axes.filter((a) => a.values.length > 0);
  if (!usable.length) return [];

  const total = product(usable);
  const cells: Cell[] = new Array(total);
  const coordsList: Array<Record<string, string>> = new Array(total);
  for (let i = 0; i < total; i++) coordsList[i] = {};

  let stride = total;
  for (const axis of usable) {
    stride = Math.floor(stride / axis.values.length);
    let idx = 0;
    while (idx < total) {
      for (const v of axis.values) {
        for (let k = 0; k < stride; k++) coordsList[idx++][axis.name] = v;
      }
    }
  }

  for (let i = 0; i < total; i++) {
    const coords = coordsList[i];
    cells[i] = { index: i, coords, key: usable.map((a) => coords[a.name]).join(SEP) };
  }
  return cells;
}

/**
 * Dựng lưới hoàn chỉnh: chuẩn hoá → thu nhỏ theo trần → broadcast.
 * Đây là hàm DUY NHẤT engine gọi; mọi thứ khác là primitive để test.
 */
export function buildGrid(input: readonly unknown[], maxCells: number = MAX_CELLS_DEFAULT): Grid {
  const cap = Math.max(1, Math.min(MAX_CELLS_LIMIT, Math.floor(maxCells) || MAX_CELLS_DEFAULT));
  const axes = shrinkAxes(normalizeAxes(input), cap);
  return { axes, cells: cartesian(axes) };
}

/* ------------------------------------------------------------------ */
/* Truy vấn — nền cho group-by / heatmap                               */
/* ------------------------------------------------------------------ */

/** Khoá gom nhóm theo MỘT hoặc NHIỀU trục (port `groupby([...])`). */
export function levelKey(coords: Record<string, string>, axisNames: readonly string[]): string {
  return axisNames.map((n) => coords[n] ?? '').join(SEP);
}

/** Danh sách mức của một trục, theo thứ tự xuất hiện trong `axes`. */
export function axisLevels(grid: Grid, axisName: string): string[] {
  const axis = grid.axes.find((a) => a.name === axisName);
  return axis ? axis.values.slice() : [];
}

/** Mô tả ngắn gọn một cell để đưa vào prompt hoặc log. */
export function describeCell(cell: Cell): string {
  return Object.entries(cell.coords)
    .map(([k, v]) => `${k} = ${v}`)
    .join(' · ');
}

/** Văn bản cấu hình cho system prompt của worker. */
export function formatCoords(cell: Cell): string {
  return Object.entries(cell.coords)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}
