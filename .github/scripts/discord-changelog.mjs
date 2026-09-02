import fs from 'node:fs';

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
  console.log('Chưa có DISCORD_WEBHOOK — bỏ qua bước thông báo.');
  process.exit(0);
}

const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const nhanh = String(ev.ref || '').replace('refs/heads/', '');
const nhanhChinh = ev.repository?.default_branch;

if (nhanh !== nhanhChinh) {
  console.log(`Push vào nhánh "${nhanh}", không phải nhánh chính "${nhanhChinh}" — bỏ qua.`);
  process.exit(0);
}

const commits = (ev.commits || []).filter((c) => c.distinct !== false);
if (commits.length === 0) {
  console.log('Không có commit mới — bỏ qua.');
  process.exit(0);
}

const NHOM = [
  [/^feat/i, '✨ Tính năng mới'],
  [/^fix/i, '🐛 Sửa lỗi'],
  [/^perf/i, '⚡ Tối ưu tốc độ'],
  [/^refactor/i, '♻️ Dọn dẹp code'],
  [/^(docs?|readme)/i, '📝 Tài liệu'],
  [/^(style|ui|design)/i, '🎨 Giao diện'],
  [/^(test|ci|build|chore|deps)/i, '🔧 Bảo trì'],
];

const nhanNhom = (msg) => NHOM.find(([re]) => re.test(msg))?.[1] ?? '📦 Thay đổi khác';

const gonGang = (msg) =>
  msg
    .split('\n')[0]
    .replace(/^[a-z+]+(\([^)]*\))?!?:\s*/i, '')
    .trim()
    .slice(0, 110) || '(không có mô tả)';

const GIOI_HAN = 20;
const theoNhom = new Map();
for (const c of commits.slice(0, GIOI_HAN)) {
  const nhan = nhanNhom(c.message);
  if (!theoNhom.has(nhan)) theoNhom.set(nhan, []);
  theoNhom.get(nhan).push(`• [\`${c.id.slice(0, 7)}\`](${c.url}) ${gonGang(c.message)}`);
}

const phan = [...theoNhom].map(([nhan, dong]) => `**${nhan}**\n${dong.join('\n')}`);
const conLai = commits.length - Math.min(commits.length, GIOI_HAN);
if (conLai > 0) phan.push(`_…và ${conLai} commit nữa._`);

const soCommit = commits.length;
const nguoiDay = ev.pusher?.name || ev.sender?.login || 'ai đó';

const embed = {
  author: {
    name: `${ev.repository.full_name} • nhánh ${nhanh}`,
    url: ev.repository.html_url,
    icon_url: ev.sender?.avatar_url,
  },
  title: `🚀 Vừa cập nhật ${soCommit} thay đổi mới`,
  url: ev.compare,
  description: phan.join('\n\n').slice(0, 4000),
  color: 0x2ecc71,
  timestamp: new Date().toISOString(),
  footer: { text: `${nguoiDay} đẩy code • bấm tiêu đề để xem toàn bộ thay đổi` },
};

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'Cập nhật dự án',
    avatar_url: ev.sender?.avatar_url,
    embeds: [embed],
  }),
});

if (!res.ok) {
  console.error(`Discord trả về ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(`Đã gửi bản tin ${soCommit} commit vào Discord.`);
