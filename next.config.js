/** @type {import('next').NextConfig} */
const nextConfig = {
  /* Vyen desktop (Electron) mở app qua http://127.0.0.1:<port> trong khi
     server dev quảng bá localhost — Next 16 mặc định chặn dev resource
     cross-origin ("Blocked cross-origin request to Next.js dev resource").
     Cho phép cả hai tên máy cục bộ để shell không mất chunk JS. */
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

module.exports = nextConfig;
