'use client';

import React, { memo } from 'react';
import type { SnippetSegment } from '@/lib/search-utils';

export const Highlight = memo(function Highlight({
  segments,
}: {
  segments: SnippetSegment[];
}) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className="bg-indigo-500/25 text-indigo-200 rounded-[3px] px-0.5"
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        ),
      )}
    </>
  );
});
