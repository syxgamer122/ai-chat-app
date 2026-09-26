/**
 * Metadata điều hướng của màn hình Cài đặt: danh mục tab, chỉ mục tìm kiếm và
 * hàm suy ra tab từ một khoá bất kỳ.
 *
 * Tách khỏi `components/settings-dialog.tsx` (component render) vì đây là DỮ LIỆU:
 * thêm một mục cấu hình chỉ nên phải sửa file này, không phải cuộn qua phần render.
 */

import { Activity, Brain, Database, Layers, Server, Shield, Sliders } from 'lucide-react';

export type SettingsTab = 'appearance' | 'providers' | 'safety' | 'extensions' | 'memory' | 'data' | 'telemetry';

export const SETTINGS_TABS: Array<{
  id: SettingsTab;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    id: 'appearance',
    label: 'Giao diện & trải nghiệm',
    description: 'Cấu hình tham số mô hình, phong cách nhập liệu và hiệu năng hiển thị.',
    icon: Sliders,
  },
  {
    id: 'providers',
    label: 'Model & Nhà cung cấp',
    description: 'Quản lý API key cá nhân, endpoint nhà cung cấp, vision model và routing.',
    icon: Server,
  },
  {
    id: 'safety',
    label: 'Quyền & An toàn',
    description: 'Chế độ phê duyệt, phân quyền từng công cụ, staging sandbox và code mode.',
    icon: Shield,
  },
  {
    id: 'extensions',
    label: 'Mở rộng',
    description: 'Kết nối máy chủ MCP, kỹ năng SKILL.md và lệnh gõ nhanh slash commands.',
    icon: Layers,
  },
  {
    id: 'memory',
    label: 'Bộ nhớ',
    description: 'Xét duyệt đề xuất ghi nhớ từ agent và quản lý bộ nhớ có cấu trúc.',
    icon: Brain,
  },
  {
    id: 'data',
    label: 'Dữ liệu & Tự động hoá',
    description: 'Sao lưu phục hồi, thống kê token, lịch chạy recipe và quản lý dữ liệu.',
    icon: Database,
  },
  {
    id: 'telemetry',
    label: 'Đo đạc & Quan sát',
    description: 'Biểu đồ Waterfall đo đạc độ trễ turn, công cụ và token theo chuẩn OpenTelemetry.',
    icon: Activity,
  },
];

interface SearchItem {
  id: string;
  title: string;
  description: string;
  tab: SettingsTab;
  keywords: string;
}

export const SETTINGS_SEARCH_ITEMS: SearchItem[] = [
  { id: 'temp', title: 'Temperature', description: 'Độ sáng tạo và biến thiên của câu trả lời', tab: 'appearance', keywords: 'nhiet do sang tao chat chem' },
  { id: 'prompt', title: 'System Prompt', description: 'Chỉ thị hệ thống cốt lõi cho AI', tab: 'appearance', keywords: 'system prompt huong dan he thong' },
  { id: 'enter', title: 'Enter để gửi tin nhắn', description: 'Bật Enter gửi hoặc Ctrl+Enter gửi', tab: 'appearance', keywords: 'phim enter gui tin nhan xuong dong' },
  { id: 'steering', title: 'Tin xếp hàng (Steering / Follow-up)', description: 'Cách bắn hàng đợi tin nhắn khi AI bận', tab: 'appearance', keywords: 'queue steering follow up xep hang' },
  { id: 'compact', title: 'Nén tự động (Compaction)', description: 'Tự động tóm tắt khi gần trần ngữ cảnh', tab: 'appearance', keywords: 'nen tom tat context compaction' },
  { id: 'anim', title: 'Hiệu ứng chuyển động', description: 'Bật/tắt chuyển động trên máy yếu', tab: 'appearance', keywords: 'hieu ung chuyen dong animation giam giat' },
  { id: 'throttle', title: 'Tần suất vẽ lại khi stream', description: 'Điều chỉnh độ mượt và tần suất render token', tab: 'appearance', keywords: 'throttle streaming fps ve lai mượt' },
  { id: 'prov-openai', title: 'API Key OpenAI chính gốc', description: 'Dùng cho model OpenAI qua api.openai.com', tab: 'providers', keywords: 'openai key sk api key' },
  { id: 'prov-byok', title: 'Nhà cung cấp API (BYOK)', description: 'Thêm endpoint tương thích OpenAI, OpenRouter...', tab: 'providers', keywords: 'nha cung cap provider openrouter custom url' },
  { id: 'prov-vision', title: 'Model đọc ảnh (Vision)', description: 'Model mô tả ảnh cho workspace và MCP', tab: 'providers', keywords: 'vision anh image camera mo ta' },
  { id: 'prov-routing', title: 'Routing model (Lead/Worker & Mixture-of-Models)', description: 'Chuỗi dự phòng và điều phối model mạnh/rẻ', tab: 'providers', keywords: 'routing mixture lead worker fallback effort' },
  { id: 'safety-policy', title: 'Chế độ phê duyệt (Approval Policy)', description: 'Smart, Autonomous, Manual, hoặc Chat Only', tab: 'safety', keywords: 'phe duyet auto pilot smart autonomous yolo manual chat only' },
  { id: 'safety-staging', title: 'Staging Sandbox', description: 'Ghi vào bộ đệm, review batch trước khi chạm đĩa', tab: 'safety', keywords: 'staging sandbox bo dem review batch' },
  { id: 'safety-perms', title: 'Bảng phân quyền từng công cụ (Tool Permissions)', description: 'Cấu hình auto, ask, deny cho 60+ công cụ', tab: 'safety', keywords: 'phan quyen tool permissions block allow deny' },
  { id: 'safety-codemode', title: 'Code Mode (run_code)', description: 'LLM viết JavaScript gọi MCP trong sandbox', tab: 'safety', keywords: 'code mode run code js javascript sandbox' },
  { id: 'safety-emulated', title: 'Đường tool giả lập (Emulated tools)', description: 'Chạy tool qua protocol text cho gateway không hỗ trợ function calling', tab: 'safety', keywords: 'gia lap emulated tools text protocol' },
  { id: 'ext-mcp', title: 'Máy chủ MCP (Model Context Protocol)', description: 'Kết nối stdio / SSE / HTTP servers', tab: 'extensions', keywords: 'mcp servers model context protocol tools' },
  { id: 'ext-skills', title: 'Kỹ năng dạng file (SKILL.md)', description: 'Quản lý và tạo skill trong .vyen/skills/', tab: 'extensions', keywords: 'skill md disk skills ky nang' },
  { id: 'ext-slash', title: 'Lệnh gõ nhanh (Slash commands)', description: 'Gán lệnh / vào workflow recipe', tab: 'extensions', keywords: 'slash command lenh recipe' },
  { id: 'mem-candidates', title: 'Duyệt đề xuất ghi nhớ (Reviewer Gate)', description: 'Xét duyệt Nhớ / Từ chối / Hoãn các candidate', tab: 'memory', keywords: 'reviewer gate duyet de xuat pending' },
  { id: 'mem-active', title: 'Ký ức đã duyệt', description: 'Các quy tắc, gotcha, pattern đã được nạp vào recall', tab: 'memory', keywords: 'ky uc da duyet active reviewed recall' },
  { id: 'mem-agent', title: 'Bộ nhớ có cấu trúc (Agent Memory)', description: 'Quản lý theo category, tag, scope toàn cục/local', tab: 'memory', keywords: 'bo nho cau truc structured agent memory' },
  { id: 'data-autobackup', title: 'Tự động sao lưu', description: 'Định kỳ lưu bản sao lưu vào thư mục trên máy', tab: 'data', keywords: 'tu dong sao luu auto backup folder' },
  { id: 'data-backup', title: 'Sao lưu & Phục hồi (.json / .md)', description: 'Xuất hoặc nạp dữ liệu toàn bộ lịch sử chat', tab: 'data', keywords: 'sao luu phuc hoi export import json md backup' },
  { id: 'data-stats', title: 'Thống kê token sử dụng', description: 'Biểu đồ tiêu thụ token và chi phí ước tính', tab: 'data', keywords: 'thong ke token usage stats cost' },
  { id: 'data-scheduler', title: 'Lịch chạy Recipe (Scheduler)', description: 'Chạy tác vụ định kỳ bằng biểu thức cron', tab: 'data', keywords: 'scheduler cron lich trinh hen gio' },
  { id: 'data-danger', title: 'Vùng nguy hiểm (Xóa dữ liệu)', description: 'Xóa sạch toàn bộ dữ liệu ứng dụng', tab: 'data', keywords: 'vung nguy hiem xoa sach reset clear database' },
  { id: 'data-telemetry', title: 'Biểu đồ Waterfall Telemetry', description: 'Đo đạc độ trễ turn, streaming và công cụ', tab: 'telemetry', keywords: 'telemetry waterfall do dac thoi gian latency trace span opentelemetry' },
];

export function resolveSettingsTab(tab?: string): SettingsTab {
  if (!tab) return 'appearance';
  switch (tab) {
    case 'chung':
      return 'appearance';
    case 'provider':
    case 'routing':
      return 'providers';
    case 'tools':
      return 'safety';
    case 'skills':
    case 'prompts':
      return 'extensions';
    case 'memory':
      return 'memory';
    case 'stats':
    case 'schedules':
    case 'data':
      return 'data';
    case 'telemetry':
    case 'quan sat':
    case 'do dac':
      return 'telemetry';
    default:
      if (SETTINGS_TABS.some((t) => t.id === tab)) return tab as SettingsTab;
      return 'appearance';
  }
}
