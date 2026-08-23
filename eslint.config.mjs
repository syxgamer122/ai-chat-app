import next from 'eslint-config-next';
import reactHooks from 'eslint-plugin-react-hooks';

const eslintConfig = [
  { ignores: ['node_modules/**', '.next/**', 'out/**', 'gui-test-screenshots/**'] },
  ...next,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Pattern sync state/ref trong effect đã ổn định từ lâu, không phải bug
      // runtime — rule mới của eslint-config-next v16 gắn cờ hàng loạt.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // Ảnh đính kèm trong chat là data:/blob: URL — next/image không xử lý được,
      // dùng <img> có chủ đích.
      '@next/next/no-img-element': 'off',
    },
  },
];

export default eslintConfig;
