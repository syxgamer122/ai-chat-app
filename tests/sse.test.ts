import { describe, expect, it } from 'vitest';
import { pumpSseLines } from '@/lib/sse';

/** Tạo ReadableStream từ danh sách chunk chuỗi (mô phỏng gói tin mạng). */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

describe('pumpSseLines', () => {
  it('đọc payload của từng dòng data:', async () => {
    const got: string[] = [];
    await pumpSseLines(streamOf(['data: a\n', 'data: b\n']), (raw) => got.push(raw));
    expect(got).toEqual(['a', 'b']);
  });

  it('gom được dòng bị cắt giữa hai chunk', async () => {
    const got: string[] = [];
    await pumpSseLines(
      streamOf(['data: {"type":"vi', 'deo","url":"https://x/v.mp4"}\n']),
      (raw) => got.push(raw),
    );
    expect(got).toEqual(['{"type":"video","url":"https://x/v.mp4"}']);
  });

  it('bỏ qua dòng comment SSE và dòng rỗng, không coi là data', async () => {
    const got: string[] = [];
    await pumpSseLines(
      streamOf([': keepalive\n', '\n', 'data:\n', 'data: x\n']),
      (raw) => got.push(raw),
    );
    expect(got).toEqual(['x']);
  });

  it('chịu được CRLF', async () => {
    const got: string[] = [];
    await pumpSseLines(streamOf(['data: a\r\n', 'data: b\r\n']), (raw) => got.push(raw));
    expect(got).toEqual(['a', 'b']);
  });

  /**
   * Điểm cốt lõi: tạo video có quãng dài chỉ phát `: keepalive`. Idle-timer
   * dựa vào onAlive, nên keepalive PHẢI đánh thức nó — nếu chỉ tính dòng
   * `data:` thì stream đang sống sẽ bị abort oan sau 60s im lặng.
   */
  it('onAlive được gọi cho keepalive, không chỉ cho dòng data', async () => {
    let alive = 0;
    const got: string[] = [];
    await pumpSseLines(
      streamOf([': keepalive\n', ': keepalive\n', 'data: done\n']),
      (raw) => got.push(raw),
      () => {
        alive++;
      },
    );
    expect(got).toEqual(['done']);
    expect(alive).toBe(3); // mỗi chunk một lần, kể cả 2 chunk chỉ có keepalive
  });

  it('onAlive được gọi cả khi chunk chưa đủ một dòng', async () => {
    let alive = 0;
    await pumpSseLines(
      streamOf(['data: par', 'tial', ' line\n']),
      () => {},
      () => {
        alive++;
      },
    );
    expect(alive).toBe(3);
  });

  it('không có onAlive vẫn chạy bình thường', async () => {
    const got: string[] = [];
    await expect(
      pumpSseLines(streamOf(['data: a\n']), (raw) => got.push(raw)),
    ).resolves.toBeUndefined();
    expect(got).toEqual(['a']);
  });

  it('bỏ qua dòng cuối không có newline (payload chưa hoàn chỉnh)', async () => {
    const got: string[] = [];
    await pumpSseLines(streamOf(['data: a\n', 'data: incompl']), (raw) => got.push(raw));
    expect(got).toEqual(['a']);
  });
});
