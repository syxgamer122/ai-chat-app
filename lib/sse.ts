/**
 * Bộ đọc SSE dùng chung cho cả client (lib/media-generate.ts) và edge route
 * (app/api/chat/route.ts). Module thuần, không import gì.
 *
 * Trước đây mỗi bên có một bản sao gần giống nhau; tách ra để sửa một lần là
 * đúng cho cả hai, và để test được phần dễ sai nhất: gom byte giữa các chunk.
 */

/**
 * Đọc payload của từng dòng `data:` trong một SSE stream.
 *
 * @param onData  gọi với phần sau `data:` đã trim. Bỏ qua dòng rỗng.
 * @param onAlive gọi mỗi khi CÓ BYTE về từ upstream, bất kể byte đó có tạo
 *   thành dòng `data:` hay không — kể cả dòng comment SSE (`: keepalive`) hay
 *   một chunk chưa đủ một dòng. Dùng để reset idle-timer: quá trình tạo video
 *   có quãng chỉ toàn keepalive, nếu chỉ đếm dòng `data:` thì một stream đang
 *   sống vẫn bị coi là treo và bị abort oan.
 */
export async function pumpSseLines(
  body: ReadableStream<Uint8Array>,
  onData: (raw: string) => void,
  onAlive?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Có byte = upstream còn sống, dù chưa thành một dòng SSE hoàn chỉnh.
      onAlive?.();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (raw) onData(raw);
        }
      }
    }
    /* Flush đuôi: một số gateway đóng stream NGAY sau payload cuối mà không
       gửi '\n'. Im lặng bỏ phần đuôi là mất hẳn chunk cuối — nơi thường chứa
       finish_reason / mảnh text cuối cùng. Chỉ flush khi đuôi là JSON hoàn
       chỉnh: đó là dấu hiệu payload đã gửi xong và chỉ thiếu delimiter, còn
       đuôi không parse được JSON là chunk thật sự đứt giữa chừng (case đã có
       test "payload chưa hoàn chỉnh") — và mọi consumer hiện tại đều
       JSON.parse payload rồi bỏ dòng rác, nên đuôi rác ném về cũng bị bỏ. */
    buf += decoder.decode(); // xả nốt byte multibyte dở dang của decoder
    const tail = buf.replace(/\r$/, '');
    if (tail.startsWith('data:')) {
      const raw = tail.slice(5).trim();
      if (raw) {
        try {
          JSON.parse(raw);
          onData(raw);
        } catch {
          /* không phải JSON hoàn chỉnh — coi là payload đứt, bỏ như trước */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
