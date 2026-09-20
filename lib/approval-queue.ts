/**
 * Trọng tài phê duyệt — bảo đảm đúng MỘT modal phê duyệt hiện tại một thời điểm.
 *
 * ## Vì sao có file này
 *
 * Trước đây `chat-interface.tsx` có hai hàng đợi độc lập: một cho diff
 * (`diffQueueRef` + `diffOpenRef`) và một cho shell (`shellQueueRef` +
 * `shellOpenRef`). Mỗi hàng đợi tự lo việc "không ghi đè khi cùng loại gọi liên
 * tiếp", nhưng **không có trọng tài giữa hai loại**. Hệ quả: khi agent gọi SONG
 * SONG một `fs_edit` và một `shell_run` trong cùng một step, cả hai modal cùng
 * render ở `z-[80]` — chồng lên nhau, hai lớp backdrop, modal dưới không bấm
 * được nút nào.
 *
 * Logic đó nằm lẫn trong một component 5.686 dòng nên **không thể test hành vi**
 * — chỉ test được sự tồn tại của tên biến. Tách ra đây để hàng đợi trở thành
 * đơn vị thuần, kiểm chứng được bằng test thật (xem
 * `tests/approval-queue.test.ts`).
 *
 * ## Hợp đồng
 *
 * - `request()` hiện NGAY nếu chưa có gì đang hiện; nếu đang bận thì xếp hàng FIFO.
 * - `close()` mở mục kế tiếp; hết hàng đợi thì báo `onDrained`.
 * - `onRequest` được gọi cho MỌI yêu cầu (kể cả khi phải xếp hàng) — component
 *   dùng nó để báo cho reconciler biết run đang chờ người dùng, nếu không modal
 *   mở lâu sẽ bị kết luận nhầm là "stream đứt" và bị giết.
 */

/** Loại phê duyệt. Mở rộng ở đây khi thêm loại modal mới. */
export type ApprovalKind = 'diff' | 'shell';

export interface ApprovalQueueConfig<TItem> {
  /** Gọi cho MỌI yêu cầu, kể cả khi phải xếp hàng. */
  onRequest?: () => void;
  /**
   * Gọi khi mục đang hiện thay đổi. `null` = không còn mục nào hiện.
   * Component dùng để set state render modal.
   */
  onPresent: (item: TItem | null) => void;
  /** Gọi khi hàng đợi cạn hoàn toàn — run được chạy tiếp. */
  onDrained?: () => void;
}

interface Entry<TItem> {
  item: TItem;
  resolve: (approved: boolean) => void;
}

export class ApprovalQueue<TItem> {
  private waiting: Entry<TItem>[] = [];
  private active: Entry<TItem> | null = null;

  constructor(private readonly cfg: ApprovalQueueConfig<TItem>) {}

  /**
   * Xếp một yêu cầu phê duyệt.
   *
   * Trả về `true` nếu mục được hiện NGAY, `false` nếu phải xếp hàng — hữu ích
   * cho test và cho caller muốn biết mình có phải chờ không.
   */
  request(item: TItem, resolve: (approved: boolean) => void): boolean {
    this.cfg.onRequest?.();
    const entry: Entry<TItem> = { item, resolve };
    if (this.active) {
      this.waiting.push(entry);
      return false;
    }
    this.active = entry;
    this.cfg.onPresent(item);
    return true;
  }

  /**
   * Đóng mục đang hiện rồi mở mục kế tiếp trong hàng đợi.
   *
   * Trả về `true` nếu vẫn còn mục đang hiện (đã mở mục kế), `false` nếu hàng đợi
   * đã cạn — lúc đó `onDrained` được gọi.
   */
  close(): boolean {
    const next = this.waiting.shift();
    if (!next) {
      this.active = null;
      this.cfg.onPresent(null);
      this.cfg.onDrained?.();
      return false;
    }
    this.active = next;
    this.cfg.onPresent(next.item);
    return true;
  }

  /** Có modal phê duyệt nào đang hiện không. */
  get isBusy(): boolean {
    return this.active !== null;
  }

  /** Số yêu cầu đang chờ (không tính mục đang hiện). */
  get pending(): number {
    return this.waiting.length;
  }

  /**
   * Xoá sạch hàng đợi mà KHÔNG resolve các promise đang chờ.
   *
   * Chỉ dùng khi component unmount hoặc đổi phiên: promise của tool đang chờ
   * người dùng sẽ không bao giờ resolve, nhưng lúc đó lượt chạy cũng đã bị huỷ
   * nên không còn ai await.
   */
  reset(): void {
    this.waiting = [];
    this.active = null;
  }
}
