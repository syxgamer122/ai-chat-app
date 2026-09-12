/**
 * Visual inspection artifacts module.
 * Unified diff viewer, flow sketch visualizer, code-shape AST outline extractor,
 * show-me markdown builder, and cybernetic control loop.
 */

import type { ApprovalRequest } from '../hitl/types';
import type {
  VisualDiffVisualizer as IVisualDiffVisualizer,
  VisualDiffOptions,
  FlowSketchNode,
  FlowSketchOptions,
} from './types';
import { DiffViewer } from './diff-viewer';
import { FlowSketchGenerator } from './flow-sketch';
import { CodeShapeExtractor } from './code-shape';
import { ShowMeBuilder } from './show-me';

export * from './types';
export * from './diff-viewer';
export * from './flow-sketch';
export * from './code-shape';
export * from './show-me';

/**
 * Concrete implementation of VisualDiffVisualizer conforming to PROJECT.md interface contracts.
 */
export class VisualDiffVisualizer implements IVisualDiffVisualizer {
  public renderDiff(oldContent: string | null, newContent: string, options?: VisualDiffOptions): string {
    return DiffViewer.renderUnifiedDiff('diff', oldContent, newContent, options).diffText;
  }

  public renderFlowSketch(
    nodes: FlowSketchNode[],
    activeNodeId?: string,
    options?: FlowSketchOptions
  ): string {
    return FlowSketchGenerator.renderFlowSketch(nodes, activeNodeId, options);
  }

  public renderCodeShape(filePath: string, content: string): string {
    return CodeShapeExtractor.extract(filePath, content).formatted;
  }

  public buildShowMeArtifact(request: ApprovalRequest): string {
    return ShowMeBuilder.buildShowMeArtifact(request);
  }
}
