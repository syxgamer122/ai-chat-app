/**
 * Comprehensive Unit Tests for Chaitin MonkeyCode SAST Engine.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  MonkeyCodeSastScanner,
  runMonkeyCodeSast,
  MONKEYCODE_RULES,
  SastFinding,
} from '../lib/security-sast';

describe('Chaitin MonkeyCode SAST Security Engine', () => {
  const scanner = new MonkeyCodeSastScanner(process.cwd());

  it('khởi tạo thành công với bộ quy tắc chuẩn MonkeyCode', () => {
    expect(MONKEYCODE_RULES.length).toBeGreaterThanOrEqual(10);
    const ruleIds = MONKEYCODE_RULES.map((r) => r.id);
    expect(ruleIds).toContain('CMD-INJ-001');
    expect(ruleIds).toContain('PATH-TRAV-001');
    expect(ruleIds).toContain('SECRET-OPENAI-001');
    expect(ruleIds).toContain('SECRET-PRIVKEY-001');
    expect(ruleIds).toContain('EVAL-001');
    expect(ruleIds).toContain('XSS-001');
    expect(ruleIds).toContain('SSRF-001');
    expect(ruleIds).toContain('CRYPTO-001');
  });

  it('phát hiện lỗ hổng Command Injection (CWE-78)', () => {
    const cmdRule = MONKEYCODE_RULES.find((r) => r.id === 'CMD-INJ-001')!;
    const vulnerableLine = 'const out = execSync(`git checkout ${branchName}`);';
    const safeLine = "const out = spawnSync('git', ['checkout', branchName]);";

    expect(cmdRule.match(vulnerableLine, 1, vulnerableLine, 'src/service.ts')).toBe(true);
    expect(cmdRule.match(safeLine, 1, safeLine, 'src/service.ts')).toBe(false);
  });

  it('phát hiện lỗ hổng Path Traversal (CWE-22)', () => {
    const pathRule = MONKEYCODE_RULES.find((r) => r.id === 'PATH-TRAV-001')!;
    const vulnerableLine = 'const content = fs.readFileSync(req.query.file, "utf8");';
    const safeLine = 'const content = fs.readFileSync(resolveWithin(root, relPath), "utf8");';

    expect(pathRule.match(vulnerableLine, 1, vulnerableLine, 'app/api/file.ts')).toBe(true);
    expect(pathRule.match(safeLine, 1, safeLine, 'app/api/file.ts')).toBe(false);
  });

  it('phát hiện rò rỉ khóa bí mật OpenAI, Anthropic, AWS, GitHub và Private Key (CWE-798)', () => {
    const openaiRule = MONKEYCODE_RULES.find((r) => r.id === 'SECRET-OPENAI-001')!;
    const anthropicRule = MONKEYCODE_RULES.find((r) => r.id === 'SECRET-ANTHROPIC-001')!;
    const githubRule = MONKEYCODE_RULES.find((r) => r.id === 'SECRET-GITHUB-001')!;
    const awsRule = MONKEYCODE_RULES.find((r) => r.id === 'SECRET-AWS-001')!;
    const privKeyRule = MONKEYCODE_RULES.find((r) => r.id === 'SECRET-PRIVKEY-001')!;

    expect(openaiRule.match('const key = "sk-abcdef1234567890abcdef123456";', 1, '', 'src/client.ts')).toBe(true);
    expect(anthropicRule.match('const key = "sk-ant-api03-abcdef123456789012345678";', 1, '', 'src/client.ts')).toBe(true);
    expect(githubRule.match('const token = "ghp_1234567890abcdef1234567890abcdef12";', 1, '', 'src/client.ts')).toBe(true);
    expect(awsRule.match('const awsKey = "AKIAIOSFODNN7EXAMPLE";', 1, '', 'src/client.ts')).toBe(true);
    expect(privKeyRule.match('-----BEGIN RSA PRIVATE KEY-----', 1, '', 'src/cert.pem')).toBe(true);

    // Không báo động giả với placeholder hoặc biến môi trường
    expect(openaiRule.match('const key = process.env.OPENAI_API_KEY;', 1, '', 'src/client.ts')).toBe(false);
    expect(openaiRule.match('const key = "sk-placeholder-not-real";', 1, '', 'src/client.ts')).toBe(false);
  });

  it('phát hiện Regular Expression Denial of Service / ReDoS (CWE-1333)', () => {
    const redosRule = MONKEYCODE_RULES.find((r) => r.id === 'REDOS-001')!;
    const vulnerableLine = 'const regex = /([a-zA-Z0-9]+)+$/;';
    const safeLine = 'const regex = /^[a-zA-Z0-9]+$/;';

    expect(redosRule.match(vulnerableLine, 1, vulnerableLine, 'src/validator.ts')).toBe(true);
    expect(redosRule.match(safeLine, 1, safeLine, 'src/validator.ts')).toBe(false);
  });

  it('phát hiện Dangerous Eval & Dynamic Execution (CWE-95)', () => {
    const evalRule = MONKEYCODE_RULES.find((r) => r.id === 'EVAL-001')!;
    const funcRule = MONKEYCODE_RULES.find((r) => r.id === 'EVAL-002')!;

    expect(evalRule.match('const result = eval(userExpression);', 1, '', 'src/calc.ts')).toBe(true);
    expect(funcRule.match('const fn = new Function("a", "b", userCode);', 1, '', 'src/calc.ts')).toBe(true);
    expect(evalRule.match('const result = JSON.parse(userJson);', 1, '', 'src/calc.ts')).toBe(false);
  });

  it('phát hiện Cross-Site Scripting / XSS (CWE-79)', () => {
    const xssRule = MONKEYCODE_RULES.find((r) => r.id === 'XSS-001')!;
    const vulnerableLine = '<div dangerouslySetInnerHTML={{ __html: userRawHtml }} />';
    const sanitizedLine = '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userRawHtml) }} />';

    expect(xssRule.match(vulnerableLine, 1, vulnerableLine, 'components/post.tsx')).toBe(true);
    expect(xssRule.match(sanitizedLine, 1, sanitizedLine, 'components/post.tsx')).toBe(false);
  });

  it('phát hiện Insecure Cryptography MD5/SHA1 (CWE-327)', () => {
    const cryptoRule = MONKEYCODE_RULES.find((r) => r.id === 'CRYPTO-001')!;
    expect(cryptoRule.match('const h = crypto.createHash("md5").update(pwd).digest("hex");', 1, '', 'src/auth.ts')).toBe(true);
    expect(cryptoRule.match('const h = crypto.createHash("sha256").update(pwd).digest("hex");', 1, '', 'src/auth.ts')).toBe(false);
  });

  it('tính điểm an ninh chính xác theo trọng số mức độ nghiêm trọng', () => {
    const testDir = path.join(process.cwd(), 'tmp-sast-test-dir');
    fs.mkdirSync(testDir, { recursive: true });

    // File sạch: đạt điểm 100 và Grade A
    fs.writeFileSync(path.join(testDir, 'clean.ts'), 'export const hello = "world";\n', 'utf8');
    const cleanReport = runMonkeyCodeSast(testDir);
    expect(cleanReport.score).toBe(100);
    expect(cleanReport.grade).toBe('A');
    expect(cleanReport.ok).toBe(true);

    // File chứa 1 lỗ hổng Critical (Command Injection): bị trừ 25 điểm -> Score <= 75, Grade F
    fs.writeFileSync(
      path.join(testDir, 'vuln.ts'),
      'export function run(cmd: string) { execSync(`rm -rf ${cmd}`); }\n',
      'utf8'
    );
    const vulnReport = runMonkeyCodeSast(testDir);
    expect(vulnReport.ok).toBe(false);
    expect(vulnReport.summary.critical).toBeGreaterThanOrEqual(1);
    expect(vulnReport.score).toBeLessThanOrEqual(75);
    expect(vulnReport.grade).toBe('F');

    // Dọn dẹp
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('tạo text report chuẩn hóa MonkeyCode với đầy đủ thông tin remediation', () => {
    const report = scanner.scan({ maxFiles: 10 });
    expect(report.textReport).toContain('Vyen Security & Code Audit (MonkeyCode Standard)');
    expect(report.textReport).toContain('Security Score:');
    expect(report.textReport).toContain('Vulnerability Summary:');
  });
});
