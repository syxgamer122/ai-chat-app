/**
 * Comprehensive Vitest test suite for Human-in-the-Loop (HITL) approval gates.
 * Tests HMAC-SHA256 interrupt tokens, tamper detection, expiration,
 * policy evaluation, and the approval state machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HitlApprovalGate,
  ApprovalGate,
  InterruptTokenManager,
  createInterruptToken,
  verifyInterruptToken,
  type ApprovalRequest,
  type ApprovalResponse,
} from '../lib/teamwork/hitl';

describe('HitlApprovalGate - Token Cryptography & Verification', () => {
  let tokenManager: InterruptTokenManager;
  const secretKey = 'test-secret-key-32-bytes-long-super-secure!';

  beforeEach(() => {
    tokenManager = new InterruptTokenManager(secretKey);
  });

  it('should generate a valid cryptographic interrupt token with HMAC signature', () => {
    const payload = { action: 'file_write', target: 'package.json' };
    const token = tokenManager.createToken('req_123', payload, 5000);

    expect(token.requestId).toBe('req_123');
    expect(token.token).toMatch(/^hitl_v1\.[a-zA-Z0-9_-]+\.\d+\.\d+\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
    expect(token.expiresAt).toBeGreaterThan(token.issuedAt);
    expect(token.payloadHash).toHaveLength(64);
    expect(token.signature).toHaveLength(64);
  });

  it('should verify a valid token successfully with correct payload', () => {
    const payload = { action: 'shell_exec', command: 'npm install' };
    const token = tokenManager.createToken('req_abc', payload, 10000);

    const verification = tokenManager.verifyToken(token.token, payload);
    expect(verification.valid).toBe(true);
    expect(verification.tokenData?.requestId).toBe('req_abc');
    expect(verification.tokenData?.payloadHash).toBe(token.payloadHash);
  });

  it('should detect payload tampering when payload content changes', () => {
    const originalPayload = { action: 'file_write', target: 'lib/teamwork/engine.ts', data: 'console.log(1)' };
    const token = tokenManager.createToken('req_tamper', originalPayload, 5000);

    const alteredPayload = { action: 'file_write', target: 'lib/teamwork/engine.ts', data: 'console.log(2)' };
    const verification = tokenManager.verifyToken(token.token, alteredPayload);

    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain('Payload hash mismatch');
  });

  it('should detect signature tampering if token segments are modified', () => {
    const payload = { action: 'plan_confirm' };
    const token = tokenManager.createToken('req_sig', payload, 5000);

    const parts = token.token.split('.');
    // Tamper with signature
    parts[5] = parts[5].substring(0, 62) + 'aa';
    const tamperedToken = parts.join('.');

    const verification = tokenManager.verifyToken(tamperedToken, payload);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain('Signature verification failed');
  });

  it('should detect expiration when current time exceeds expiresAt', () => {
    const payload = { action: 'file_write' };
    const now = 1000000;
    const ttlMs = 5000;
    const token = tokenManager.createToken('req_exp', payload, ttlMs, now);

    // Verify at now + 2000 (valid)
    const validCheck = tokenManager.verifyToken(token.token, payload, now + 2000);
    expect(validCheck.valid).toBe(true);

    // Verify at now + 6000 (expired)
    const expiredCheck = tokenManager.verifyToken(token.token, payload, now + 6000);
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toContain('Token expired');
  });

  it('should compute deterministic hashes irrespective of object key ordering', () => {
    const objA = { b: 2, a: 1, c: { y: 'hello', x: 'world' } };
    const objB = { c: { x: 'world', y: 'hello' }, a: 1, b: 2 };

    const hashA = tokenManager.hashPayload(objA);
    const hashB = tokenManager.hashPayload(objB);

    expect(hashA).toBe(hashB);
  });

  it('should support standalone helper functions createInterruptToken and verifyInterruptToken', () => {
    const token = createInterruptToken('helper_req', { step: 1 }, 3000, secretKey);
    expect(token.requestId).toBe('helper_req');

    const result = verifyInterruptToken(token.token, { step: 1 }, secretKey);
    expect(result.valid).toBe(true);
  });
});

describe('HitlApprovalGate - Policy Engine & Risk Evaluation', () => {
  it('should allow all operations without interrupt when policy is "never"', () => {
    const gate = new HitlApprovalGate({ policy: 'never' });

    const evalRes = gate.evaluate({
      action: 'shell_exec',
      target: 'rm -rf /',
      description: 'Dangerous wipe',
    });

    expect(evalRes.shouldInterrupt).toBe(false);
    expect(evalRes.riskScore).toBe(0);
  });

  it('should interrupt every operation when policy is "always"', () => {
    const gate = new HitlApprovalGate({ policy: 'always' });

    const evalRes = gate.evaluate({
      action: 'fs_write',
      target: 'readme.txt',
      description: 'Minor doc update',
    });

    expect(evalRes.shouldInterrupt).toBe(true);
    expect(evalRes.riskScore).toBe(100);
    expect(evalRes.severity).toBe('CRITICAL');
  });

  it('under "smart" policy, should flag protected core project files', () => {
    const gate = new HitlApprovalGate({ policy: 'smart' });

    const evalPackage = gate.evaluate({
      action: 'file_write',
      target: 'package.json',
      description: 'Add dependency',
    });
    expect(evalPackage.shouldInterrupt).toBe(true);
    expect(evalPackage.riskScore).toBeGreaterThanOrEqual(85);
    expect(evalPackage.severity).toBe('CRITICAL');

    const evalTsConfig = gate.evaluate({
      action: 'file_write',
      target: 'tsconfig.json',
      description: 'Modify compiler options',
    });
    expect(evalTsConfig.shouldInterrupt).toBe(true);

    const evalEnv = gate.evaluate({
      action: 'file_write',
      target: '.env.local',
      description: 'Update secret env',
    });
    expect(evalEnv.shouldInterrupt).toBe(true);

    const evalTeamwork = gate.evaluate({
      action: 'fs_edit',
      target: 'lib/teamwork/engine.ts',
      description: 'Modify multi-agent engine',
    });
    expect(evalTeamwork.shouldInterrupt).toBe(true);
  });

  it('under "smart" policy, should flag dangerous shell commands', () => {
    const gate = new HitlApprovalGate({ policy: 'smart' });

    const evalRm = gate.evaluate({
      action: 'shell_exec',
      target: 'rm -rf ./node_modules',
      description: 'Clean modules',
    });
    expect(evalRm.shouldInterrupt).toBe(true);
    expect(evalRm.riskScore).toBe(95);

    const evalGitForce = gate.evaluate({
      action: 'shell_exec',
      target: 'git push --force origin main',
      description: 'Force push branch',
    });
    expect(evalGitForce.shouldInterrupt).toBe(true);
    expect(evalGitForce.riskScore).toBe(95);
  });

  it('under "smart" policy, should flag diff size exceeding threshold', () => {
    const gate = new HitlApprovalGate({ policy: 'smart', maxDiffLinesThreshold: 50 });

    const evalNormal = gate.evaluate({
      action: 'file_write',
      target: 'src/components/button.tsx',
      diffLines: 20,
    });
    expect(evalNormal.shouldInterrupt).toBe(false);

    const evalLarge = gate.evaluate({
      action: 'file_write',
      target: 'src/components/button.tsx',
      diffLines: 120,
    });
    expect(evalLarge.shouldInterrupt).toBe(true);
    expect(evalLarge.reasons.some((r) => r.includes('threshold of 50 lines'))).toBe(true);
  });

  it('under "smart" policy, should flag milestone advance without Critic PASS', () => {
    const gate = new HitlApprovalGate({ policy: 'smart' });

    const evalAdvanceFail = gate.evaluate({
      action: 'milestone_advance',
      target: 'M2',
      metadata: { criticVerdict: 'FAIL-BLOCKED' },
    });
    expect(evalAdvanceFail.shouldInterrupt).toBe(true);

    const evalAdvancePass = gate.evaluate({
      action: 'milestone_advance',
      target: 'M2',
      metadata: { criticVerdict: 'PASS' },
    });
    expect(evalAdvancePass.shouldInterrupt).toBe(false);
  });

  it('should support custom policy rules', () => {
    const gate = new HitlApprovalGate({ policy: 'smart' });

    gate.registerRule({
      name: 'no_friday_deploys',
      evaluate: (req) => {
        if (req.metadata?.isFridayDeploy) {
          return { triggered: true, riskScore: 90, severity: 'CRITICAL', reason: 'Deployments on Friday require human approval' };
        }
        return { triggered: false };
      },
    });

    const normal = gate.evaluate({
      action: 'file_write',
      target: 'src/index.ts',
      metadata: { isFridayDeploy: false },
    });
    expect(normal.shouldInterrupt).toBe(false);

    const friday = gate.evaluate({
      action: 'file_write',
      target: 'src/index.ts',
      metadata: { isFridayDeploy: true },
    });
    expect(friday.shouldInterrupt).toBe(true);
    expect(friday.reasons).toContain('Deployments on Friday require human approval');
  });
});

describe('HitlApprovalGate - State Machine & Request Lifecycle', () => {
  let gate: HitlApprovalGate;
  let simulatedTime = 1000000;

  beforeEach(() => {
    simulatedTime = 1000000;
    gate = new HitlApprovalGate({
      policy: 'smart',
      clock: () => simulatedTime,
      ttlMs: 10000,
    });
  });

  it('should create an approval request with PENDING_APPROVAL state and valid token', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Update dependency versions',
      proposedPayload: { dependencies: { lodash: '^4.17.21' } },
    });

    expect(request.id).toMatch(/^hitl_req_/);
    expect(request.state).toBe('PENDING_APPROVAL');
    expect(request.severity).toBe('CRITICAL');
    expect(request.token).toBeDefined();

    const pending = gate.listPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(request.id);
  });

  it('should transition state to APPROVED upon valid approval response', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Update dependency',
      proposedPayload: { dep: 'vitest' },
    });

    const response: ApprovalResponse = {
      requestId: request.id,
      token: request.token,
      decision: 'APPROVED',
      approver: 'admin-user',
      comments: 'Looks safe to update',
    };

    const resolved = gate.respond(response);
    expect(resolved.state).toBe('APPROVED');
    expect(resolved.decision).toBe('APPROVED');
    expect(resolved.resolvedBy).toBe('admin-user');
    expect(resolved.resolutionComments).toBe('Looks safe to update');

    // Should no longer be pending
    expect(gate.listPendingRequests()).toHaveLength(0);
  });

  it('should transition state to REJECTED upon valid rejection response', () => {
    const request = gate.createRequest({
      action: 'shell_exec',
      target: 'rm -rf dist',
      description: 'Delete build output',
    });

    const response: ApprovalResponse = {
      requestId: request.id,
      token: request.token,
      decision: 'REJECTED',
      approver: 'qa-engineer',
      comments: 'Use npm run clean instead',
    };

    const resolved = gate.respond(response);
    expect(resolved.state).toBe('REJECTED');
    expect(resolved.decision).toBe('REJECTED');
    expect(resolved.resolvedBy).toBe('qa-engineer');
  });

  it('should transition state to MODIFIED and store modified payload', () => {
    const originalPayload = { config: 'dev' };
    const request = gate.createRequest({
      action: 'file_write',
      target: 'config.json',
      description: 'Set configuration',
      proposedPayload: originalPayload,
    });

    const modifiedPayload = { config: 'production', safeMode: true };
    const response: ApprovalResponse = {
      requestId: request.id,
      token: request.token,
      decision: 'MODIFIED',
      approver: 'lead-architect',
      comments: 'Applied production settings',
      modifiedPayload,
    };

    const resolved = gate.respond(response);
    expect(resolved.state).toBe('MODIFIED');
    expect(resolved.decision).toBe('MODIFIED');
    expect(resolved.modifiedPayload).toEqual(modifiedPayload);
  });

  it('should prevent double resolution of the same request', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Test',
    });

    gate.respond({
      requestId: request.id,
      token: request.token,
      decision: 'APPROVED',
      approver: 'user1',
    });

    expect(() => {
      gate.respond({
        requestId: request.id,
        token: request.token,
        decision: 'REJECTED',
        approver: 'user2',
      });
    }).toThrow(/already resolved/);
  });

  it('should reject response if interrupt token is invalid or tampered', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Test',
    });

    expect(() => {
      gate.respond({
        requestId: request.id,
        token: 'invalid.token.here',
        decision: 'APPROVED',
        approver: 'user',
      });
    }).toThrow(/Invalid interrupt token/);
  });

  it('should transition to EXPIRED when responding after expiration timestamp', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Test',
      ttlMs: 5000,
    });

    // Advance clock past expiration
    simulatedTime += 6000;

    expect(() => {
      gate.respond({
        requestId: request.id,
        token: request.token,
        decision: 'APPROVED',
        approver: 'late-user',
      });
    }).toThrow(/expired/);

    const stored = gate.getRequest(request.id);
    expect(stored?.state).toBe('EXPIRED');
  });

  it('should support asynchronous waitForDecision with concurrent approval', async () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'Async test',
    });

    // Fire approval in background
    setTimeout(() => {
      gate.respond({
        requestId: request.id,
        token: request.token,
        decision: 'APPROVED',
        approver: 'async-worker',
      });
    }, 20);

    const resolved = await gate.waitForDecision(request.id, 1000);
    expect(resolved.state).toBe('APPROVED');
    expect(resolved.resolvedBy).toBe('async-worker');
  });

  it('should support request cancellation', () => {
    const request = gate.createRequest({
      action: 'file_write',
      target: 'package.json',
      description: 'To cancel',
    });

    const cancelled = gate.cancelRequest(request.id, 'User cancelled workflow');
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.resolutionComments).toBe('User cancelled workflow');
  });

  it('should export ApprovalGate alias identical to HitlApprovalGate', () => {
    expect(ApprovalGate).toBe(HitlApprovalGate);
  });
});
