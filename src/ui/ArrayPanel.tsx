import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { boundsCenter, boundsSize, tidy, unionBounds } from '../model/math';
import type { Vec3 } from '../model/types';
import { geometry } from '../state/geometry';
import { ARRAY_LIMIT, arrayFrame, cancelArray, commitArray, previewArray, selectedNodes } from '../state/store';
import type { ArrayRequest } from '../state/store';
import { NumberBox } from './Fields';

const AXES = ['X', 'Y', 'Z'] as const;
const BIG = 100000;

/**
 * The Array popover: lays the selection out in a grid or a ring, live, and
 * keeps the pattern on Apply. Closing the panel any other way drops it.
 */
export function ArrayPanel({ close }: { close: () => void }) {
  // The selection as it was when the panel opened; the preview selects the pattern itself.
  const picked = useRef(selectedNodes()).current;
  const frame = useMemo(() => arrayFrame(picked), [picked]);
  const seeds = useMemo(() => picked.filter((n) => n !== frame), [picked, frame]);
  const seedBounds = useMemo(() => unionBounds(seeds.map((n) => geometry.bounds(n))), [seeds]);
  const frameBounds = useMemo(() => (frame ? geometry.bounds(frame) : null), [frame]);

  const [mode, setMode] = useState<'grid' | 'ring'>('grid');
  const [count, setCount] = useState<[number, number, number]>([2, frame ? 2 : 1, 1]);
  const [pitch, setPitch] = useState<Vec3>(() => boundsSize(seedBounds).map((v) => tidy(Math.max(v, 1))) as Vec3);
  const [fit, setFit] = useState(Boolean(frame));
  const [inset, setInset] = useState(5);
  const [ring, setRing] = useState(6);
  const [sweep, setSweep] = useState(360);
  const [turn, setTurn] = useState(true);
  const [centre, setCentre] = useState<[number, number]>(() => {
    if (frameBounds) {
      const c = boundsCenter(frameBounds);
      return [tidy(c[0]), tidy(c[1])];
    }
    // Round the plate's origin, unless the object sits on it: then a little to one side, so the ring shows.
    const c = boundsCenter(seedBounds);
    if (Math.hypot(c[0], c[1]) < 0.5) return [tidy(c[0] - 2 * Math.max(boundsSize(seedBounds)[0], 5)), tidy(c[1])];
    return [0, 0];
  });
  const fitId = useId();
  const turnId = useId();

  const fitted = fit && frame !== null;
  const request: ArrayRequest =
    mode === 'grid' ? { kind: 'grid', count, pitch, ...(fitted ? { fit: { inset } } : {}) } : { kind: 'ring', count: ring, sweep, centre, turn };
  const places = mode === 'grid' ? count[0] * count[1] * count[2] : ring;
  const tooMany = places > ARRAY_LIMIT;

  // Every change shows straight away; the key keeps the effect to real changes.
  const key = JSON.stringify(request);
  useEffect(() => {
    previewArray(JSON.parse(key) as ArrayRequest);
  }, [key]);
  const applied = useRef(false);
  useEffect(
    () => () => {
      if (!applied.current) cancelArray();
    },
    [],
  );

  const apply = () => {
    applied.current = true;
    commitArray();
    close();
  };
  /** Spacing a fitted axis works out to, shown greyed. */
  const fittedPitch = (axis: 0 | 1 | 2): number => {
    if (!frameBounds || axis === 2 || count[axis] < 2) return pitch[axis];
    const size = boundsSize(frameBounds)[axis];
    return tidy((size - 2 * inset) / (count[axis] - 1));
  };

  return (
    <div className="align-panel array-panel">
      <p>
        {mode === 'grid'
          ? 'Copies in a row, a grid or a stack: how many along each axis, and the distance between their centres.'
          : 'Copies round a circle: the selection is one of them, the rest follow at equal angles.'}
      </p>
      <div className="segmented" role="radiogroup" aria-label="Pattern">
        {(['grid', 'ring'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {m === 'grid' ? 'Grid' : 'Ring'}
          </button>
        ))}
      </div>
      {mode === 'grid' ? (
        <>
          <div className="array-head" aria-hidden>
            <span />
            <span>Count</span>
            <span>Spacing</span>
          </div>
          {AXES.map((tag, axis) => {
            const a = axis as 0 | 1 | 2;
            const locked = fitted && a < 2 && count[a] > 1;
            return (
              <div className="array-row" key={tag}>
                <span>{tag}</span>
                <NumberBox
                  label={`Count along ${tag}`}
                  value={count[a]}
                  min={1}
                  max={100}
                  integer
                  onChange={(v) => setCount(count.map((c, i) => (i === a ? v : c)) as [number, number, number])}
                />
                <NumberBox
                  label={locked ? `Spacing along ${tag}, from the fit` : `Spacing along ${tag}`}
                  value={locked ? fittedPitch(a) : pitch[a]}
                  unit="mm"
                  min={-BIG}
                  max={BIG}
                  disabled={locked}
                  onChange={(v) => setPitch(pitch.map((p, i) => (i === a ? v : p)) as Vec3)}
                />
              </div>
            );
          })}
          {frame && (
            <>
              <div className="field inline">
                <label htmlFor={fitId} title={`${frame.name} stays put; the copies spread over it`}>
                  Fit inside {frame.name}
                </label>
                <input id={fitId} className="switch" type="checkbox" role="switch" checked={fit} onChange={(e) => setFit(e.target.checked)} />
              </div>
              {fit && (
                <div className="field inline">
                  <label>Centres in from its edges</label>
                  <NumberBox label="Distance from the edges to the centres of the first and last copies" value={inset} unit="mm" min={-BIG} max={BIG} onChange={setInset} />
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="array-row">
            <span />
            <NumberBox label="Number of copies round the ring" tag="N" value={ring} min={2} max={ARRAY_LIMIT} integer onChange={setRing} />
            <NumberBox label="Degrees the pattern spreads over" tag="∠" value={sweep} unit="°" min={1} max={360} onChange={setSweep} />
          </div>
          <div className="array-head" aria-hidden>
            <span />
            <span>Centre</span>
            <span />
          </div>
          <div className="array-row">
            <span />
            <NumberBox label="X of the centre of the ring" tag="X" value={centre[0]} unit="mm" min={-BIG} max={BIG} onChange={(v) => setCentre([v, centre[1]])} />
            <NumberBox label="Y of the centre of the ring" tag="Y" value={centre[1]} unit="mm" min={-BIG} max={BIG} onChange={(v) => setCentre([centre[0], v])} />
          </div>
          <div className="field inline">
            <label htmlFor={turnId} title="Each copy turns with its place on the ring; off, they all keep the original's heading">
              Turn copies round the ring
            </label>
            <input id={turnId} className="switch" type="checkbox" role="switch" checked={turn} onChange={(e) => setTurn(e.target.checked)} />
          </div>
        </>
      )}
      <div className="array-foot">
        <span className={tooMany ? 'field-note warn' : 'field-note'}>{tooMany ? `At most ${ARRAY_LIMIT} places` : `${places} place${places === 1 ? '' : 's'}`}</span>
        <button type="button" className="primary" disabled={tooMany || places < 2 || seeds.length === 0} onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}
