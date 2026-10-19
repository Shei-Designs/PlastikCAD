// One settings box for several sections, shown one at a time under a row of
// tabs drawn like the sidebar's page tabs. A long row scrolls sideways rather
// than wrapping, so the box keeps one height whatever the part.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export interface Section {
  title: string;
  /** A shorter name for the tab, when the title is long. */
  tab?: string;
  content: ReactNode;
  /** Shown under the box while this section is open. */
  after?: ReactNode;
}

export function Sections({ legend, extra, sections, reset }: { legend: string; extra?: ReactNode; sections: Section[]; reset: string }) {
  const [tab, setTab] = useState(sections[0]?.title);
  // Another object, or another kind of part: back to the first section.
  useEffect(() => setTab(sections[0]?.title), [reset]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = sections.find((s) => s.title === tab) ?? sections[0];
  if (!current) return null;
  const tabbed = sections.length > 1;
  return (
    <>
      <fieldset className={tabbed ? 'group tabbed' : 'group'}>
        <legend>
          {tabbed ? legend : current.title}
          {extra}
        </legend>
        {tabbed && (
          <div className="section-tabs" role="tablist">
            {sections.map((s) => (
              <button key={s.title} type="button" role="tab" aria-selected={s === current} className={s === current ? 'on' : ''} onClick={() => setTab(s.title)}>
                {s.tab ?? s.title}
              </button>
            ))}
          </div>
        )}
        {current.content}
      </fieldset>
      {current.after}
    </>
  );
}
