/**
 * Live tools — dữ liệu thời gian thực mà LLM không bao giờ biết (thời tiết,
 * tỷ giá hôm nay), theo đúng pattern webContext: client detect ý định → gọi
 * API free không key (CORS OK) → format thành khối text chèn vào system prompt.
 *
 * API chọn tiêu chí: miễn phí vĩnh viễn, không key, hỗ trợ CORS:
 *   - Open-Meteo (geocoding + forecast) — thời tiết
 *   - open.er-api.com — tỷ giá (có VND, cập nhật hằng ngày)
 *
 * Mọi fetch nhận qua tham số để test không cần network.
 */

/* ------------------------------------------------------------------ */
/* Nhận diện ý định                                                    */
/* ------------------------------------------------------------------ */

const WEATHER_RE =
  /(?<![\p{L}])(thời tiết|thoi tiet|dự báo|du bao|nhiệt độ|nhiet do|mưa|mua\?|nắng|weather|forecast|temp(?:erature)?)(?![\p{L}])/iu;
/** Cụm chỉ địa điểm sau giới từ — bắt trước dấu câu/ngắt dòng. Lưu ý: \b của
 * JS chỉ tính [A-Za-z0-9_] nên KHÔNG dùng được với chữ có dấu — thay bằng
 * lookahead/lookbehind [\p{L}]. */
const LOCATION_RE = /(?:^|[^\p{L}'’])(?:ở|tại|in|at)\s+([\p{L}][\p{L}\s.'’-]{1,38})/iu;
/** Cắt đuôi dư sau tên nơi: từ nối/thời gian/động từ hỏi. */
const LOCATION_TAIL_RE =
  /\s+(?:như|hôm|ngày|mai|tuần|hiện|bây\s+giờ|không|chứ|vậy|có|thế|ra\s+sao)(?![\p{L}])/iu;
const RATES_RE =
  /(?<![\p{L}])(tỷ giá|tỉ giá|ty gia|exchange rate|giá\s?(?:usd|eur|vnd|jpy|gbp|cny|krw|thb|sgd|aud)|đổi tiền|doi tien|quy đổi|quy doi)(?![\p{L}])/iu;

export interface LiveIntent {
  /** Có ý định hỏi thời tiết. */
  weather: boolean;
  /** Cụm địa điểm trích từ câu hỏi; null nếu chỉ nói chung chung. */
  weatherLocation: string | null;
  rates: boolean;
}

export function detectLiveIntent(text: string): LiveIntent {
  const t = text ?? '';
  let weatherLocation: string | null = null;
  const weather = WEATHER_RE.test(t);

  if (weather) {
    // Ưu tiên cụm "ở X" trong cùng câu có từ khóa thời tiết; lọc đuôi dư.
    const m = LOCATION_RE.exec(t);
    if (m) {
      weatherLocation = m[1].split(LOCATION_TAIL_RE)[0].trim();
      if (weatherLocation.length < 2) weatherLocation = null;
    }
  }

  return { weather, weatherLocation, rates: RATES_RE.test(t) };
}

/* ------------------------------------------------------------------ */
/* Thời tiết                                                           */
/* ------------------------------------------------------------------ */

/** WMO weather interpretation codes → mô tả ngắn tiếng Việt. */
export function describeWeatherCode(code: number): string {
  const table: Array<[number[], string]> = [
    [[0], 'trời quang'],
    [[1, 2], 'ít mây'],
    [[3], 'nhiều mây'],
    [[45, 48], 'sương mù'],
    [[51, 53, 55], 'mưa phùn'],
    [[56, 57], 'mưa phùn đóng băng'],
    [[61], 'mưa nhẹ'],
    [[63], 'mưa vừa'],
    [[65], 'mưa to'],
    [[66, 67], 'mưa đóng băng'],
    [[71], 'mưa tuyết nhẹ'],
    [[73], 'mưa tuyết'],
    [[75], 'mưa tuyết nặng'],
    [[77], 'hạt tuyết'],
    [[80], 'mưa rào nhẹ'],
    [[81], 'mưa rào'],
    [[82], 'mưa rào dữ dội'],
    [[85, 86], 'mưa tuyết rào'],
    [[95], 'dông'],
    [[96, 99], 'dông kèm mưa đá'],
  ];
  for (const [codes, label] of table) if (codes.includes(code)) return label;
  return 'không xác định';
}

export interface WeatherDeps {
  geocodingUrl: (loc: string) => string;
  forecastUrl: (lat: number, lon: number) => string;
}

const DEFAULT_WEATHER_DEPS: WeatherDeps = {
  geocodingUrl: (loc) =>
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=vi&format=json`,
  forecastUrl: (lat, lon) =>
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2',
};

/**
 * Tra thời tiết theo tên nơi. Trả chuỗi đã format sẵn để nhét thẳng vào
 * system prompt, hoặc null khi không tra được (địa điểm lạ/mạng lỗi) —
 * caller cứ bỏ khối, KHÔNG tự bịa dữ liệu thay thế.
 */
export async function fetchWeather(
  location: string,
  deps: Partial<WeatherDeps> = {},
): Promise<string | null> {
  const d = { ...DEFAULT_WEATHER_DEPS, ...deps };
  try {
    const geoRes = await fetch(d.geocodingUrl(location), {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!geoRes.ok) return null;
    const geo = (await geoRes.json()) as {
      results?: Array<{ name: string; country?: string; admin1?: string; latitude: number; longitude: number }>;
    };
    const place = geo.results?.[0];
    if (!place) return null;

    const fcRes = await fetch(d.forecastUrl(place.latitude, place.longitude), {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!fcRes.ok) return null;
    const fc = (await fcRes.json()) as {
      current?: Record<string, number>;
      daily?: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: number[];
      };
    };

    const c = fc.current;
    const day = fc.daily;
    if (!c || !day?.time?.length) return null;

    const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const lines = [
      `[DỮ LIỆU THỜI TIẾT HIỆN TẠI — nguồn Open-Meteo, ${where}]`,
      `- Hiện tại: ${Math.round(c.temperature_2m)}°C, ${describeWeatherCode(Number(c.weather_code))}, ` +
        `cảm giác như ${Math.round(c.apparent_temperature)}°C, độ ẩm ${Math.round(c.relative_humidity_2m)}%, ` +
        `gió ${Math.round(c.wind_speed_10m)} km/h.`,
      `- Hôm nay (${day.time[0]}): ${day.temperature_2m_min?.[0] != null ? `${Math.round(day.temperature_2m_min[0])}–` : ''}` +
        `${day.temperature_2m_max?.[0] != null ? `${Math.round(day.temperature_2m_max[0])}°C` : 'n/a'}` +
        `${day.precipitation_probability_max?.[0] != null ? `, khả năng mưa ${day.precipitation_probability_max[0]}%` : ''}.`,
    ];
    if (day.time[1]) {
      lines.push(
        `- Ngày mai (${day.time[1]}): ${day.temperature_2m_min?.[1] != null ? `${Math.round(day.temperature_2m_min[1])}–` : ''}` +
          `${day.temperature_2m_max?.[1] != null ? `${Math.round(day.temperature_2m_max[1])}°C` : 'n/a'}` +
          `${day.precipitation_probability_max?.[1] != null ? `, khả năng mưa ${day.precipitation_probability_max[1]}%` : ''}.`,
      );
    }
    lines.push('[Cách dùng] Trả lời dựa trên số liệu này; nếu người dùng hỏi nơi khác thì nói rõ dữ liệu chỉ phủ nơi trên.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Tỷ giá                                                              */
/* ------------------------------------------------------------------ */

/** Các đồng hay hỏi, USD làm gốc. VND luôn giữ nếu API trả về. */
const WATCHED_CURRENCIES = ['VND', 'EUR', 'JPY', 'GBP', 'CNY', 'KRW', 'THB', 'SGD', 'AUD'] as const;

const CURRENCY_NAMES: Record<string, string> = {
  VND: 'VNĐ',
  EUR: 'EUR (Euro)',
  JPY: 'JPY (Yên Nhật)',
  GBP: 'GBP (Bảng Anh)',
  CNY: 'CNY (Nhân dân tệ)',
  KRW: 'KRW (Won Hàn)',
  THB: 'THB (Bạt Thái)',
  SGD: 'SGD (Đô Singapore)',
  AUD: 'AUD (Đô Úc)',
};

export interface RatesResult {
  updatedAt: string | null;
  /** Giá trị 1 USD = X đơn vị đồng đó. */
  usdRates: Partial<Record<(typeof WATCHED_CURRENCIES)[number], number>>;
}

export function parseRates(json: unknown): RatesResult {
  const data = json as { time_last_update_utc?: string; rates?: Record<string, number> };
  const rates = data?.rates;
  if (!rates || typeof rates !== 'object') return { updatedAt: null, usdRates: {} };
  const usdRates: RatesResult['usdRates'] = {};
  for (const cur of WATCHED_CURRENCIES) {
    const v = rates[cur];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) usdRates[cur] = v;
  }
  return { updatedAt: typeof data.time_last_update_utc === 'string' ? data.time_last_update_utc : null, usdRates };
}

/** Định dạng khối tỷ giá từ kết quả đã parse — tách khỏi fetch để test dễ. */
export function formatRatesBlock(result: RatesResult): string | null {
  const { usdRates, updatedAt } = result;
  if (!usdRates.VND) return null;
  const vnd = Math.round(usdRates.VND);
  const lines = [
    `[TỶ GIÁ HÔM NAY — nguồn open.er-api.com${updatedAt ? `, cập nhật: ${updatedAt.slice(0, 16)}` : ''}]`,
    `1 USD ≈ ${vnd.toLocaleString('vi-VN')} VNĐ`,
  ];
  for (const cur of WATCHED_CURRENCIES) {
    if (cur === 'VND' || !usdRates[cur]) continue;
    const perUsd = usdRates[cur];
    const vndPerCur = (usdRates.VND as number) / perUsd;
    lines.push(
      `1 ${CURRENCY_NAMES[cur]} ≈ ${Math.round(vndPerCur).toLocaleString('vi-VN')} VNĐ (≈ ${perUsd.toFixed(2)} USD)`,
    );
  }
  lines.push('[Cách dùng] Tỷ giá tham chiếu hằng ngày, có thể khác tỷ giá ngân hàng. Quy đổi nhân/chia trực tiếp từ số liệu trên.');
  return lines.join('\n');
}

export async function fetchRates(): Promise<string | null> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return formatRatesBlock(parseRates(await res.json()));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Điểm vào tổng                                                       */
/* ------------------------------------------------------------------ */

export interface LiveContextPayload {
  weather?: string;
  rates?: string;
}

/**
 * Chạy cả hai tool theo ý định của tin nhắn. Không bao giờ ném lỗi — tool
 * chết chỉ nghĩa là thiếu khối dữ liệu, việc gửi tin nhắn phải tiếp tục.
 */
export async function gatherLiveContext(
  messageText: string,
  fetchers: { weather?: typeof fetchWeather; rates?: typeof fetchRates } = {},
): Promise<LiveContextPayload | null> {
  const intent = detectLiveIntent(messageText);
  if (!intent.weather && !intent.rates) return null;

  const [weather, rates] = await Promise.all([
    intent.weather
      ? (fetchers.weather ?? fetchWeather)(intent.weatherLocation ?? 'Hà Nội')
      : Promise.resolve(null),
    intent.rates ? (fetchers.rates ?? fetchRates)() : Promise.resolve(null),
  ]);

  const payload: LiveContextPayload = {};
  if (weather) payload.weather = weather;
  if (rates) payload.rates = rates;
  return Object.keys(payload).length ? payload : null;
}
