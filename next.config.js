/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Bỏ qua lỗi TypeScript khi build
    ignoreBuildErrors: true,
  },
  eslint: {
    // Bỏ qua lỗi ESLint khi build
    ignoreDuringBuilds: true,
  },
};
module.exports = nextConfig;