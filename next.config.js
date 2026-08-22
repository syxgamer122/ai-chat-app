/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Bỏ qua lỗi TypeScript khi build
    ignoreBuildErrors: true,
  },
};
module.exports = nextConfig;