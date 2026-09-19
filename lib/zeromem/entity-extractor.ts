/**
 * Zero-Mem Rule-Based Entity Extractor (Zero LLM Calls).
 *
 * Extracts structured code entities from raw conversation traces and code snippets
 * deterministically without invoking any LLM, guaranteeing zero token cost and zero latency.
 */

import type { ZeroMemEntity, ZeroMemRelation, ZeroMemEntityKind } from './types';

export interface ExtractedEntitiesResult {
  entities: ZeroMemEntity[];
  relations: ZeroMemRelation[];
}

/**
 * Regex patterns for zero-token algorithmic entity detection.
 */
const FILE_PATH_RE = /(?:^|[\s"'`([<{])((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|css|html|yaml|yml|sh|toml))(?:$|[\s"'`)\]>}?:,.])/g;
const FUNCTION_RE = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g;
const CLASS_INTERFACE_RE = /(?:export\s+)?(?:class|interface|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const ERROR_DIAGNOSTIC_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|Error|TS\d{4,5}|EADDRINUSE|ENOENT|EACCES|AssertionError):\s*([^\r\n]+)/g;
const TOOL_COMMAND_RE = /\b(npm\s+run\s+[a-zA-Z0-9_:-]+|npx\s+[a-zA-Z0-9_:-]+|git\s+[a-zA-Z0-9_:-]+|vitest|eslint|tsc)\b/g;
const IMPORT_SOURCE_RE = /(?:import|from)\s+['"]([.@/][^'"]+)['"]/g;

/** Known architectural frameworks and core concepts */
const CONCEPT_KEYWORDS = [
  'next.js',
  'react',
  'vitest',
  'dexie',
  'tailwind',
  'indexeddb',
  'dag',
  'bm25',
  'mcp',
  'hitl',
  'bitemporal',
  'zero-mem',
  'sarsed',
];

/**
 * Normalize entity name to generate deterministic ID.
 */
export function buildEntityId(kind: ZeroMemEntityKind, name: string): string {
  const clean = name.trim().toLowerCase().replace(/[\\/\s:]+/g, '_');
  return `ent:${kind}:${clean}`;
}

/**
 * Extract entities and inter-entity relations from text and context without LLM calls.
 */
export function extractEntities(
  text: string,
  options: {
    workspaceKey?: string;
    now?: number;
    filePathHint?: string;
    toolNameHint?: string;
  } = {},
): ExtractedEntitiesResult {
  const now = options.now ?? Date.now();
  const scope = options.workspaceKey ?? '*';
  const entitiesMap = new Map<string, ZeroMemEntity>();
  const relations: ZeroMemRelation[] = [];

  const addEntity = (name: string, kind: ZeroMemEntityKind, attributes: Record<string, unknown> = {}): ZeroMemEntity => {
    const id = buildEntityId(kind, name);
    const existing = entitiesMap.get(id);
    if (existing) {
      existing.hitCount += 1;
      existing.updatedAt = now;
      Object.assign(existing.attributes, attributes);
      return existing;
    }
    const created: ZeroMemEntity = {
      id,
      name,
      kind,
      scope,
      attributes,
      createdAt: now,
      updatedAt: now,
      hitCount: 1,
    };
    entitiesMap.set(id, created);
    return created;
  };

  // 1. File Path Hint
  let currentFileEntity: ZeroMemEntity | undefined;
  if (options.filePathHint) {
    currentFileEntity = addEntity(options.filePathHint.replace(/\\/g, '/'), 'file', {
      isHint: true,
    });
  }

  // 2. Tool Name Hint
  let currentToolEntity: ZeroMemEntity | undefined;
  if (options.toolNameHint) {
    currentToolEntity = addEntity(options.toolNameHint, 'tool', {
      isHint: true,
    });
    if (currentFileEntity) {
      relations.push({
        id: `rel:${currentToolEntity.id}:modifies:${currentFileEntity.id}`,
        sourceId: currentToolEntity.id,
        targetId: currentFileEntity.id,
        relationType: 'modifies',
        weight: 0.9,
        createdAt: now,
      });
    }
  }

  // 3. Extract File Paths from text
  const fileMatches = text.matchAll(FILE_PATH_RE);
  for (const match of fileMatches) {
    const rawPath = match[1];
    if (rawPath && rawPath.length > 3 && !rawPath.startsWith('http')) {
      const normalizedPath = rawPath.replace(/\\/g, '/');
      const fileEnt = addEntity(normalizedPath, 'file', { inContent: true });
      if (currentToolEntity) {
        relations.push({
          id: `rel:${currentToolEntity.id}:references:${fileEnt.id}`,
          sourceId: currentToolEntity.id,
          targetId: fileEnt.id,
          relationType: 'references',
          weight: 0.7,
          createdAt: now,
        });
      }
      if (!currentFileEntity) {
        currentFileEntity = fileEnt;
      }
    }
  }

  // 4. Extract Functions & Methods
  const funcMatches = text.matchAll(FUNCTION_RE);
  for (const match of funcMatches) {
    const fnName = match[1] || match[2];
    if (fnName && fnName.length >= 2) {
      const fnEnt = addEntity(fnName, 'symbol', { symbolType: 'function' });
      if (currentFileEntity) {
        relations.push({
          id: `rel:${currentFileEntity.id}:defines:${fnEnt.id}`,
          sourceId: currentFileEntity.id,
          targetId: fnEnt.id,
          relationType: 'defines',
          weight: 1.0,
          createdAt: now,
        });
      }
    }
  }

  // 5. Extract Classes / Interfaces / Types
  const classMatches = text.matchAll(CLASS_INTERFACE_RE);
  for (const match of classMatches) {
    const className = match[1];
    if (className && className.length >= 2) {
      const classEnt = addEntity(className, 'symbol', { symbolType: 'type_or_class' });
      if (currentFileEntity) {
        relations.push({
          id: `rel:${currentFileEntity.id}:defines:${classEnt.id}`,
          sourceId: currentFileEntity.id,
          targetId: classEnt.id,
          relationType: 'defines',
          weight: 1.0,
          createdAt: now,
        });
      }
    }
  }

  // 6. Extract Errors & Diagnostics
  const errorMatches = text.matchAll(ERROR_DIAGNOSTIC_RE);
  for (const match of errorMatches) {
    const errCode = match[1];
    const errMsg = match[2]?.trim().slice(0, 160);
    const errName = `${errCode}: ${errMsg}`;
    const errEnt = addEntity(errName, 'error', { code: errCode, message: errMsg });
    if (currentFileEntity) {
      relations.push({
        id: `rel:${currentFileEntity.id}:causes_error:${errEnt.id}`,
        sourceId: currentFileEntity.id,
        targetId: errEnt.id,
        relationType: 'causes_error',
        weight: 0.85,
        createdAt: now,
      });
    }
  }

  // 7. Extract Commands & Tools
  const cmdMatches = text.matchAll(TOOL_COMMAND_RE);
  for (const match of cmdMatches) {
    const cmd = match[1].trim();
    if (cmd) {
      addEntity(cmd, 'tool', { command: cmd });
    }
  }

  // 8. Extract Import references
  const importMatches = text.matchAll(IMPORT_SOURCE_RE);
  for (const match of importMatches) {
    const target = match[1];
    if (target && currentFileEntity) {
      const targetEnt = addEntity(target, 'file', { importSource: true });
      relations.push({
        id: `rel:${currentFileEntity.id}:imports:${targetEnt.id}`,
        sourceId: currentFileEntity.id,
        targetId: targetEnt.id,
        relationType: 'imports',
        weight: 0.8,
        createdAt: now,
      });
    }
  }

  // 9. Extract Concept keywords
  const lowerText = text.toLowerCase();
  for (const concept of CONCEPT_KEYWORDS) {
    if (lowerText.includes(concept)) {
      addEntity(concept, 'concept', { term: concept });
    }
  }

  return {
    entities: Array.from(entitiesMap.values()),
    relations,
  };
}
