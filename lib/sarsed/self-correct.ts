/**
 * Sarsed-Code Autonomous SARS (Sense-Analyze-Refactor-Synthesize) Self-Correction Loop.
 *
 * Implements a closed cybernetic feedback loop for autonomous coding:
 * 1. Sense: Run verification commands (compiler, linter, tests).
 * 2. Analyze: Extract structured diagnostics targeting touched files.
 * 3. Refactor: Formulate repair patches targeting failing lines.
 * 4. Synthesize: Apply patches and re-verify iteratively (up to maxAttempts).
 * 5. Rollback Safety: Automatically reverts to pre-edit state if unresolvable regression occurs.
 */

import { SarsedPatcher } from './patcher';
import type {
  CodeDiagnostic,
  SelfCorrectionAttempt,
  SelfCorrectionReport,
  SemanticPatch,
  VerificationResult,
} from './types';
import { SarsedVerifier } from './verifier';

export interface SelfCorrectionExecutor {
  runVerification: (command: string) => Promise<{ exitCode: number; output: string }>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  generateRepairPatch?: (
    diagnostics: CodeDiagnostic[],
    fileContent: string,
  ) => Promise<SemanticPatch | null>;
}

export class SarsedSelfCorrectionLoop {
  private verifier: SarsedVerifier;
  private patcher: SarsedPatcher;

  constructor() {
    this.verifier = new SarsedVerifier();
    this.patcher = new SarsedPatcher();
  }

  /**
   * Run self-correction loop on touched files.
   */
  async executeLoop(
    verificationCommand: string,
    touchedFiles: string[],
    executor: SelfCorrectionExecutor,
    maxAttempts: number = 3,
  ): Promise<SelfCorrectionReport> {
    const attempts: SelfCorrectionAttempt[] = [];
    const filesFixed = new Set<string>();

    // Initial snapshot of all touched files for rollback safety
    const fileSnapshots = new Map<string, string>();
    for (const f of touchedFiles) {
      try {
        const content = await executor.readFile(f);
        fileSnapshots.set(f, content);
      } catch {
        // file may be newly created
      }
    }

    let currentAttempt = 0;
    let finalDiagnostics: CodeDiagnostic[] = [];

    while (currentAttempt < maxAttempts) {
      currentAttempt++;

      // 1. SENSE: Run verification
      const verifyRes = await executor.runVerification(verificationCommand);
      const allDiagnostics = this.verifier.parseDiagnostics(verifyRes.output);
      const relevantDiagnostics = this.verifier.filterByFiles(allDiagnostics, touchedFiles);

      finalDiagnostics = relevantDiagnostics;

      // If 0 errors on touched files, we succeeded!
      const errorCount = relevantDiagnostics.filter((d) => d.severity === 'error').length;
      if (errorCount === 0 && verifyRes.exitCode === 0) {
        attempts.push({
          attempt: currentAttempt,
          diagnostics: relevantDiagnostics,
          success: true,
          commentary: `Verification passed completely on attempt #${currentAttempt}.`,
        });
        return {
          success: true,
          totalAttempts: currentAttempt,
          attempts,
          finalDiagnostics: [],
          filesFixed: Array.from(filesFixed),
        };
      }

      // 2. ANALYZE: Diagnose failing files
      const failingFile = relevantDiagnostics[0]?.file;
      const commentary = `Attempt #${currentAttempt}: Found ${errorCount} errors in ${relevantDiagnostics.map((d) => d.file).join(', ')}.`;

      if (!failingFile || !executor.generateRepairPatch) {
        // No automatic patch generator available, record diagnostic report
        attempts.push({
          attempt: currentAttempt,
          diagnostics: relevantDiagnostics,
          success: false,
          commentary: `${commentary} Awaiting targeted model intervention.`,
        });
        break;
      }

      // 3. REFACTOR: Generate targeted repair patch
      const fileContent = await executor.readFile(failingFile);
      const patch = await executor.generateRepairPatch(relevantDiagnostics, fileContent);

      if (!patch) {
        attempts.push({
          attempt: currentAttempt,
          diagnostics: relevantDiagnostics,
          success: false,
          commentary: `${commentary} Could not formulate repair patch.`,
        });
        break;
      }

      // 4. SYNTHESIZE: Apply patch
      const patchRes = this.patcher.applyPatch(failingFile, fileContent, patch);
      if (patchRes.success && patchRes.modifiedContent) {
        await executor.writeFile(failingFile, patchRes.modifiedContent);
        filesFixed.add(failingFile);

        attempts.push({
          attempt: currentAttempt,
          diagnostics: relevantDiagnostics,
          patchProposed: patch,
          success: false, // will be verified in next loop iteration
          commentary: `Applied repair patch for ${failingFile}. Re-running verification.`,
        });
      } else {
        attempts.push({
          attempt: currentAttempt,
          diagnostics: relevantDiagnostics,
          patchProposed: patch,
          success: false,
          commentary: `Repair patch application failed: ${patchRes.error}.`,
        });
        break;
      }
    }

    // If still failing after max attempts, restore pre-edit snapshots to avoid corruption
    const isSuccess = finalDiagnostics.filter((d) => d.severity === 'error').length === 0;
    if (!isSuccess && fileSnapshots.size > 0) {
      for (const [file, original] of fileSnapshots.entries()) {
        try {
          await executor.writeFile(file, original);
        } catch {
          // ignore rollback failure
        }
      }
    }

    return {
      success: isSuccess,
      totalAttempts: currentAttempt,
      attempts,
      finalDiagnostics,
      filesFixed: isSuccess ? Array.from(filesFixed) : [],
    };
  }
}
