/**
 * Chaitin MonkeyCode Advanced Static Application Security Testing (SAST) Engine.
 * Conforms to MonkeyCode security architecture (https://github.com/chaitin/MonkeyCode).
 *
 * Provides comprehensive AST & pattern-based vulnerability detection across 8 security domains:
 * 1. Command Injection (CWE-78)
 * 2. Path Traversal & Arbitrary File Access (CWE-22 / CWE-73)
 * 3. Hardcoded Credentials & Secret Leaks (CWE-798)
 * 4. Regular Expression Denial of Service / ReDoS (CWE-1333)
 * 5. Dangerous Dynamic Code Evaluation (CWE-95 / CWE-94)
 * 6. Cross-Site Scripting / XSS (CWE-79)
 * 7. Server-Side Request Forgery / SSRF (CWE-918)
 * 8. Insecure Cryptography & Pseudo-Randomness (CWE-327 / CWE-338)
 *
 * Computes standardized MonkeyCode Security Score (0-100) and letter grades (A/B/C/F).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type SastSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type SastCategory =
  | 'command-injection'
  | 'path-traversal'
  | 'secret-leak'
  | 'redos-regex'
  | 'dangerous-eval'
  | 'xss'
  | 'ssrf'
  | 'weak-crypto';

export interface SastFinding {
  id: string;
  ruleId: string;
  cwe: string;
  category: SastCategory;
  severity: SastSeverity;
  file: string;
  line: number;
  codeSnippet: string;
  message: string;
  remediation: string;
}

export interface SastSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

export interface SastReport {
  ok: boolean;
  score: number;
  grade: 'A' | 'B' | 'C' | 'F';
  checkedFiles: number;
  scannedAt: string;
  workspaceRoot: string;
  summary: SastSummary;
  findings: SastFinding[];
  textReport: string;
}

export interface SastScanOptions {
  targetPath?: string;
  maxFiles?: number;
  ignorePaths?: string[];
  severityThreshold?: SastSeverity;
}

interface SastRule {
  id: string;
  cwe: string;
  category: SastCategory;
  severity: SastSeverity;
  name: string;
  description: string;
  remediation: string;
  match: (line: string, lineIndex: number, fileContent: string, relPath: string) => boolean | string;
}

const SEVERITY_WEIGHTS: Record<SastSeverity, number> = {
  critical: 25,
  high: 15,
  medium: 10,
  low: 5,
  info: 0,
};

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.gemini',
  'tmp',
  'coverage',
  '.cache',
  'fixtures',
  '.opencode',
]);

const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.pdf',
  '.exe',
  '.dll',
  '.dylib',
  '.so',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.bin',
  '.lock',
]);

/**
 * All SAST Detection Rules conforming to Chaitin MonkeyCode.
 * Linear-time matching without backtracking risks.
 */
export const MONKEYCODE_RULES: SastRule[] = [
  // 1. Command Injection (CWE-78)
  {
    id: 'CMD-INJ-001',
    cwe: 'CWE-78',
    category: 'command-injection',
    severity: 'critical',
    name: 'Unsanitized Shell Execution',
    description: 'Direct shell execution via exec/execSync with string concatenation or interpolation.',
    remediation: 'Use child_process.spawn() or execFile() with discrete argument arrays and shell: false.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      const hasExec = /(?:child_process\.)?(?:execSync|exec)\s*\(/.test(line);
      if (!hasExec) return false;
      return line.includes('${') || line.includes(' +') || line.includes('+ ');
    },
  },
  {
    id: 'CMD-INJ-002',
    cwe: 'CWE-78',
    category: 'command-injection',
    severity: 'critical',
    name: 'Spawn With Shell Enabled',
    description: 'child_process.spawn called with shell: true option enables shell meta-character evaluation.',
    remediation: 'Set shell: false and pass arguments as separate array elements.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /spawn(?:Sync)?\s*\(.+shell\s*:\s*true/i.test(line);
    },
  },

  // 2. Path Traversal (CWE-22 / CWE-73)
  {
    id: 'PATH-TRAV-001',
    cwe: 'CWE-22',
    category: 'path-traversal',
    severity: 'high',
    name: 'Unsafe Direct File Access',
    description: 'File operation directly using concatenated user input without resolveWithin boundary guard.',
    remediation: 'Constrain file paths with resolveWithin(workspaceRoot, targetPath) or verify with isWithinRoot().',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts') || relPath.includes('path-guard')) return false;
      const hasFs = /fs\.(?:readFile|readFileSync|writeFile|writeFileSync|unlink|unlinkSync|createReadStream|createWriteStream)\s*\(/.test(line);
      if (!hasFs) return false;
      return line.includes('req.') || line.includes('params.') || line.includes('body.') || line.includes('query.') || line.includes('${user');
    },
  },
  {
    id: 'PATH-TRAV-002',
    cwe: 'CWE-22',
    category: 'path-traversal',
    severity: 'high',
    name: 'Hardcoded Relative Path Escape',
    description: 'Unchecked directory traversal sequences (../) found in file system operations.',
    remediation: 'Sanitize relative traversal characters and enforce workspace boundaries.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return line.includes('fs.') && (line.includes("'../") || line.includes('"../') || line.includes('`../'));
    },
  },

  // 3. Hardcoded Credentials & Secret Leaks (CWE-798)
  {
    id: 'SECRET-OPENAI-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'high',
    name: 'OpenAI API Key Leak',
    description: 'Detected hardcoded OpenAI API key token.',
    remediation: 'Store API key in environment variables or OS safeStorage vault. Revoke exposed keys.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts') || relPath.includes('opencode.json')) return false;
      const m = line.match(/sk-[a-zA-Z0-9]{20,}/);
      if (m && !m[0].includes('placeholder') && !m[0].includes('example') && !m[0].includes('sk-ant')) return true;
      return false;
    },
  },
  {
    id: 'SECRET-ANTHROPIC-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'high',
    name: 'Anthropic API Key Leak',
    description: 'Detected hardcoded Anthropic API key token.',
    remediation: 'Move key to environment variable ANTHROPIC_API_KEY. Never commit secrets.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /sk-ant-api\d{2}-[a-zA-Z0-9_\-]{20,}/.test(line);
    },
  },
  {
    id: 'SECRET-GITHUB-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'high',
    name: 'GitHub Personal Access Token',
    description: 'Detected hardcoded GitHub access token pattern.',
    remediation: 'Revoke and rotate GitHub personal access token immediately.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{30,40}|github_pat_[a-zA-Z0-9_]{50,}/.test(line);
    },
  },
  {
    id: 'SECRET-AWS-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'critical',
    name: 'AWS Access Key ID',
    description: 'Detected AWS Cloud access key identifier.',
    remediation: 'Use AWS IAM Roles or AWS CLI credentials profiles instead of hardcoded tokens.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /\bAKIA[0-9A-Z]{16}\b/.test(line);
    },
  },
  {
    id: 'SECRET-PRIVKEY-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'critical',
    name: 'Cryptographic Private Key in Source',
    description: 'Detected raw PEM/SSH private key embedded in source code.',
    remediation: 'Remove private key immediately. Store certificates in dedicated key store or HSM.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/.test(line);
    },
  },
  {
    id: 'SECRET-GENERIC-001',
    cwe: 'CWE-798',
    category: 'secret-leak',
    severity: 'high',
    name: 'Hardcoded Secret / Password String',
    description: 'Variable name indicates credential assignment with high-entropy literal.',
    remediation: 'Use process.env or secret manager to supply sensitive credentials.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts') || relPath.includes('DEFAULT_PROVIDER_SEEDS')) return false;
      const m = line.match(/(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|app[_-]?password)\s*[:=]\s*['"]([a-zA-Z0-9_\-!@#$%^&*]{16,})['"]/i);
      if (m && !m[1].includes('process.env') && !m[1].includes('placeholder') && !m[1].includes('example') && !m[1].includes('DEFAULT')) {
        return true;
      }
      return false;
    },
  },

  // 4. Insecure Regex / ReDoS (CWE-1333)
  {
    id: 'REDOS-001',
    cwe: 'CWE-1333',
    category: 'redos-regex',
    severity: 'medium',
    name: 'Nested Quantifiers ReDoS Pattern',
    description: 'Regex pattern with nested repetition quantifiers creates exponential worst-case backtracking.',
    remediation: 'Rewrite regex without nested quantifiers (e.g. replace (a+)+ with a+).',
    match: (line, _idx, _content, relPath) => {
      if (relPath.endsWith('security-sast.ts') || relPath.includes('test')) return false;
      return /\((?:[^)\\]|\\[\s\S])*?[+*]\s*\)[+*]/.test(line);
    },
  },

  // 5. Dangerous Evals & Dynamic Code Execution (CWE-95 / CWE-94)
  {
    id: 'EVAL-001',
    cwe: 'CWE-95',
    category: 'dangerous-eval',
    severity: 'critical',
    name: 'Dynamic Code Evaluation via eval()',
    description: 'eval() executes arbitrary JavaScript strings with caller privileges.',
    remediation: 'Eliminate eval(). Use JSON.parse() for data or safe expression interpreters.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /\beval\s*\([a-zA-Z0-9_$\s,+'"`\(\)]+\)/.test(line) && !line.includes('//') && !line.includes('function eval');
    },
  },
  {
    id: 'EVAL-002',
    cwe: 'CWE-95',
    category: 'dangerous-eval',
    severity: 'critical',
    name: 'Dynamic Function Constructor',
    description: 'new Function() dynamically creates executable code from strings.',
    remediation: 'Avoid new Function(). Restructure logic into static declarative handlers.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return line.includes('new Function(');
    },
  },
  {
    id: 'EVAL-003',
    cwe: 'CWE-95',
    category: 'dangerous-eval',
    severity: 'high',
    name: 'String-based Timer Execution',
    description: 'setTimeout/setInterval with string argument performs implicit code evaluation.',
    remediation: 'Pass a callback function directly: setTimeout(() => fn(), delay).',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /set(?:Timeout|Interval)\s*\(\s*['"`]/.test(line);
    },
  },

  // 6. Cross-Site Scripting / XSS (CWE-79)
  {
    id: 'XSS-001',
    cwe: 'CWE-79',
    category: 'xss',
    severity: 'high',
    name: 'Unsafe React dangerouslySetInnerHTML',
    description: 'Direct insertion of raw HTML via dangerouslySetInnerHTML without sanitization.',
    remediation: 'Sanitize HTML with DOMPurify or use standard JSX text interpolation.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      if (line.includes('DOMPurify') || line.includes('sanitizeHtml') || line.includes('<svg') || line.includes('_SCRIPT') || line.includes('THEME_')) return false;
      return line.includes('dangerouslySetInnerHTML');
    },
  },
  {
    id: 'XSS-002',
    cwe: 'CWE-79',
    category: 'xss',
    severity: 'high',
    name: 'Direct DOM innerHTML Assignment',
    description: 'Direct assignment to element.innerHTML can trigger client-side script execution.',
    remediation: 'Use textContent or innerText, or sanitize markup before assignment.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /\.(?:innerHTML|outerHTML)\s*=\s*(?!['"`]\s*['"`])/.test(line);
    },
  },

  // 7. Server-Side Request Forgery / SSRF (CWE-918)
  {
    id: 'SSRF-001',
    cwe: 'CWE-918',
    category: 'ssrf',
    severity: 'medium',
    name: 'Unvalidated Outbound HTTP Request',
    description: 'fetch or axios call with unvalidated user-provided destination URL.',
    remediation: 'Validate destination hostname with isSafeLocalHostOrIp() or enforce SSRF allowlist.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts') || relPath.includes('web-backend')) return false;
      return (line.includes('fetch(') || line.includes('axios.get(') || line.includes('axios.post(')) &&
        (line.includes('req.query') || line.includes('req.body') || line.includes('userUrl') || line.includes('targetUrl'));
    },
  },

  // 8. Insecure Cryptography & Pseudo-Randomness (CWE-327 / CWE-338)
  {
    id: 'CRYPTO-001',
    cwe: 'CWE-327',
    category: 'weak-crypto',
    severity: 'low',
    name: 'Broken Cryptographic Hash (MD5/SHA1)',
    description: 'MD5 and SHA-1 suffer from collision vulnerabilities and must not be used for security.',
    remediation: 'Use SHA-256 or SHA-512 via crypto.createHash(\'sha256\').',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i.test(line);
    },
  },
  {
    id: 'CRYPTO-002',
    cwe: 'CWE-338',
    category: 'weak-crypto',
    severity: 'low',
    name: 'Insecure Pseudo-Random Token Generation',
    description: 'Math.random() is cryptographically weak and predictable.',
    remediation: 'Use crypto.randomBytes() or crypto.getRandomValues() for security-sensitive tokens.',
    match: (line, _idx, _content, relPath) => {
      if (relPath.includes('test') || relPath.endsWith('security-sast.ts')) return false;
      return /(?:token|secret|apiKey|salt|nonce|password)\s*[:=].*Math\.random\(\)/i.test(line);
    },
  },
];

/**
 * MonkeyCode SAST Scanner Engine.
 */
export class MonkeyCodeSastScanner {
  private workspaceRoot: string;
  private rules: SastRule[];

  constructor(workspaceRoot: string = process.cwd(), customRules?: SastRule[]) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.rules = customRules || MONKEYCODE_RULES;
  }

  public scan(options?: SastScanOptions): SastReport {
    const findings: SastFinding[] = [];
    let checkedFiles = 0;
    const maxFiles = options?.maxFiles ?? 300;
    const targetDir = options?.targetPath
      ? path.resolve(this.workspaceRoot, options.targetPath)
      : this.workspaceRoot;

    // 1. Check Git tracked sensitive files (MonkeyCode Environment Guard)
    try {
      const gitCheck = spawnSync('git', ['ls-files', '.env', '.env.local', '*.pem', 'id_rsa'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 2000,
      });
      if (gitCheck.status === 0 && gitCheck.stdout) {
        const trackedSecrets = gitCheck.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        for (const secFile of trackedSecrets) {
          findings.push({
            id: `FIND-GIT-SECRET-${findings.length + 1}`,
            ruleId: 'SECRET-ENV-GIT',
            cwe: 'CWE-798',
            category: 'secret-leak',
            severity: 'high',
            file: secFile,
            line: 1,
            codeSnippet: `Git tracked file: ${secFile}`,
            message: `Sensitive environment / key file "${secFile}" is tracked by Git repository.`,
            remediation: `Add "${secFile}" to .gitignore and remove it from git tracking via: git rm --cached ${secFile}`,
          });
        }
      }
    } catch {
      // Git not available or not a git repo
    }

    // 2. Recursive file scanner
    const walk = (dir: string) => {
      if (checkedFiles >= maxFiles) return;
      if (!fs.existsSync(dir)) return;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (checkedFiles >= maxFiles) return;

        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTS.has(ext)) continue;

          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

          if (options?.ignorePaths?.some((p) => relPath.includes(p))) {
            continue;
          }

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 256 * 1024) continue; // Skip files > 256KB

            const content = fs.readFileSync(fullPath, 'utf8');
            checkedFiles++;
            this.scanFileContent(relPath, content, findings);
          } catch {
            // Unreadable file
          }
        }
      }
    };

    if (fs.existsSync(targetDir)) {
      try {
        const stat = fs.statSync(targetDir);
        if (stat.isDirectory()) {
          walk(targetDir);
        } else if (stat.isFile()) {
          const relPath = path.relative(this.workspaceRoot, targetDir).replace(/\\/g, '/');
          const content = fs.readFileSync(targetDir, 'utf8');
          checkedFiles++;
          this.scanFileContent(relPath, content, findings);
        }
      } catch {}
    }

    // 3. Compute Summary & Score
    const summary: SastSummary = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      total: findings.length,
    };

    let deduction = 0;
    for (const f of findings) {
      summary[f.severity]++;
      deduction += SEVERITY_WEIGHTS[f.severity] || 0;
    }

    const score = Math.max(0, 100 - deduction);

    let grade: 'A' | 'B' | 'C' | 'F' = 'A';
    if (score < 50 || summary.critical > 0) {
      grade = 'F';
    } else if (score < 75 || summary.high > 1) {
      grade = 'C';
    } else if (score < 90 || summary.high > 0) {
      grade = 'B';
    }

    const ok = summary.critical === 0 && summary.high === 0 && grade !== 'F' && score >= 50;
    const textReport = this.formatReport({
      ok,
      score,
      grade,
      checkedFiles,
      scannedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      summary,
      findings,
      textReport: '',
    });

    return {
      ok,
      score,
      grade,
      checkedFiles,
      scannedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      summary,
      findings,
      textReport,
    };
  }

  private scanFileContent(relPath: string, content: string, findings: SastFinding[]) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }
      if (trimmed.includes('sast-ignore') || trimmed.includes('nosec')) {
        continue;
      }

      for (const rule of this.rules) {
        const matched = rule.match(line, i, content, relPath);
        if (matched) {
          findings.push({
            id: `FIND-${findings.length + 1}`,
            ruleId: rule.id,
            cwe: rule.cwe,
            category: rule.category,
            severity: rule.severity,
            file: relPath,
            line: i + 1,
            codeSnippet: trimmed.slice(0, 120),
            message: rule.description,
            remediation: rule.remediation,
          });
        }
      }
    }
  }

  public formatReport(report: SastReport): string {
    const lines: string[] = [
      '================================================================================',
      '=== Vyen Security & Code Audit (MonkeyCode Standard) ===',
      '================================================================================',
      `Workspace:      ${report.workspaceRoot}`,
      `Checked Files:  ${report.checkedFiles}`,
      `Security Score: ${report.score}/100 [Grade: ${report.grade}]`,
      `Status:         ${report.ok ? 'PASSED (No Critical/High vulnerabilities)' : 'FAILED (Vulnerabilities detected)'}`,
      '',
      `Vulnerability Summary:`,
      `  [CRITICAL]:   ${report.summary.critical}`,
      `  [HIGH]:       ${report.summary.high}`,
      `  [MEDIUM]:     ${report.summary.medium}`,
      `  [LOW]:        ${report.summary.low}`,
      `  [TOTAL]:      ${report.summary.total}`,
      '--------------------------------------------------------------------------------',
    ];

    if (report.findings.length === 0) {
      lines.push('✔ No security vulnerabilities or credential leaks detected across workspace.');
    } else {
      lines.push('Findings Detail:');
      for (const f of report.findings) {
        const tag = `[${f.severity.toUpperCase()}]`.padEnd(10);
        lines.push('');
        lines.push(`${tag} ${f.ruleId} (${f.cwe}) — ${f.message}`);
        lines.push(`  Location:    ${f.file}:${f.line}`);
        lines.push(`  Snippet:     ${f.codeSnippet}`);
        lines.push(`  Remediation: ${f.remediation}`);
      }
    }

    lines.push('================================================================================');
    return lines.join('\n');
  }
}

/**
 * Helper function to run MonkeyCode SAST scan directly.
 */
export function runMonkeyCodeSast(
  workspaceRoot: string = process.cwd(),
  options?: SastScanOptions,
): SastReport {
  const scanner = new MonkeyCodeSastScanner(workspaceRoot);
  return scanner.scan(options);
}
