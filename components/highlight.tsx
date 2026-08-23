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
            className="rounded-[3px] bg-brand/15 px-0.5 text-brand"
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
