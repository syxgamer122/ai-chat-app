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
            className="bg-[#0A7E8C]/20 text-[#0A7E8C] rounded-[3px] px-0.5"
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
