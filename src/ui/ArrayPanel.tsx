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
  const frameBounds = useMemo(() => (frame ? geometry.bounds(frame) : null), [frame]);
  // The objects being patterned when the frame is the reference: everything but the frame.
  const others = useMemo(() => picked.filter((n) => n !== frame), [picked, frame]);
  const othersBounds = useMemo(() => unionBounds(others.map((n) => geometry.bounds(n))), [others]);

  const [mode, setMode] = useState<'grid' | 'ring'>('grid');
  const [count, setCount] = useState<[number, number, number]>([2, frame ? 2 : 1, 1]);
  const [pitch, setPitch] = useState<Vec3>(() => boundsSize(othersBounds).map((v) => tidy(Math.max(v, 1))) as Vec3);
  const [fit, setFit] = useState(Boolean(frame));
  const [inset, setInset] = useState(5);
  const [ring, setRing] = useState(6);
  const [sweep, setSweep] = useState(360);
  const [turn, setTurn] = useState(true);
  // What the ring goes around: the selection marks the center and moves out to the radius, the frame's center, or a typed point.
  const [around, setAround] = useState<'selection' | 'frame' | 'point'>(frame ? 'frame' : 'selection');
  const [radius, setRadius] = useState(() => {
    if (!frameBounds) return 20;
    const [w, d] = boundsSize(frameBounds);
    return tidy(Math.max(5, Math.min(w, d) / 2 - 5));
  });
  const [point, setPoint] = useState<[number, number]>(() => {
    const c = boundsCenter(othersBounds);
    return [tidy(c[0]), tidy(c[1])];
  });
  const fitId = useId();
  const turnId = useId();

  const fitted = fit && frame !== null;
  // The frame stays put only while it is the reference; otherwise it is patterned with the rest, as the store does.
  const framed = mode === 'grid' ? fitted : around === 'frame' && frame !== null;
  const seeds = framed ? others : picked;
  const seedCenter = boundsCenter(framed ? othersBounds : unionBounds(picked.map((n) => geometry.bounds(n))));
  const request: ArrayRequest =
    mode === 'grid'
      ? { kind: 'grid', count, pitch, ...(fitted ? { fit: { inset } } : {}) }
      : around === 'selection'
        ? { kind: 'ring', count: ring, sweep, center: [tidy(seedCenter[0]), tidy(seedCenter[1])], radius, turn }
        : around === 'frame' && frame
          ? { kind: 'ring', count: ring, sweep, center: 'frame', turn }
          : { kind: 'ring', count: ring, sweep, center: point, turn };
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
  /** Spacing a fitted axis works out to, shown grayed. */
  const fittedPitch = (axis: 0 | 1 | 2): number => {
    if (!frameBounds || axis === 2 || count[axis] < 2) return pitch[axis];
    const size = boundsSize(frameBounds)[axis];
    return tidy((size - 2 * inset) / (count[axis] - 1));
  };

  return (
    <div className="align-panel array-panel">
      <div className="array-title">Array</div>
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
                  <label>Centers in from its edges</label>
                  <NumberBox label="Distance from the edges to the centers of the first and last copies" value={inset} unit="mm" min={-BIG} max={BIG} onChange={setInset} />
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="array-head" aria-hidden>
            <span className="wide">Around</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="What the ring goes around">
            {(frame ? (['selection', 'frame', 'point'] as const) : (['selection', 'point'] as const)).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={around === a} className={around === a ? 'on' : ''} onClick={() => setAround(a)}>
                {a === 'selection' ? 'Selection' : a === 'frame' ? frame!.name : 'Fixed point'}
              </button>
            ))}
          </div>
          <div className="array-pair head" aria-hidden>
            <span>Copies</span>
            <span>Angle</span>
          </div>
          <div className="array-pair">
            <NumberBox label="Number of copies around the ring" value={ring} min={2} max={ARRAY_LIMIT} integer onChange={setRing} />
            <NumberBox label="Degrees the pattern spreads over" value={sweep} unit="°" min={1} max={360} onChange={setSweep} />
          </div>
          {around === 'selection' ? (
            <>
              <div className="array-pair head" aria-hidden>
                <span>Radius</span>
                <span>Diameter</span>
              </div>
              <div className="array-pair">
                <NumberBox label="Radius of the ring" value={radius} unit="mm" min={0} max={BIG} onChange={setRadius} />
                <NumberBox label="Diameter of the ring" value={tidy(2 * radius)} unit="mm" min={0} max={BIG} onChange={(v) => setRadius(tidy(v / 2))} />
              </div>
            </>
          ) : around === 'frame' && frame ? null : (
            <>
              <div className="array-pair head" aria-hidden>
                <span>Center X</span>
                <span>Center Y</span>
              </div>
              <div className="array-pair">
                <NumberBox label="X of the center of the ring" value={point[0]} unit="mm" min={-BIG} max={BIG} onChange={(v) => setPoint([v, point[1]])} />
                <NumberBox label="Y of the center of the ring" value={point[1]} unit="mm" min={-BIG} max={BIG} onChange={(v) => setPoint([point[0], v])} />
              </div>
            </>
          )}
          <div className="field inline">
            <label htmlFor={turnId} title="Each copy turns to face its place on the ring; off, they all keep the original's heading">
              Rotate copies around the ring
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
