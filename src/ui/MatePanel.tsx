// The mating gear wizard: while it is open the mate stands next to its gear in
// the scene, rebuilt as the figures change, and Accept keeps it. It is driven
// by the store's `mating` state, so it stays up while the view is orbited;
// Escape or Cancel drops the preview.
import { useEffect, useId, useState } from 'react';
import { fixedMateTeeth, MATE_KIND_LABELS, mateKinds, mateOf, sourceTeeth } from '../parts/mates';
import type { MateKind, MateRequest } from '../parts/mates';
import type { Params } from '../parts/generators/types';
import { cancelMate, commitMate, previewMate, useEditor } from '../state/store';
import { formatNumber, NumberBox } from './Fields';
import { Hint } from './Hint';

const num = (p: Params, key: string, fallback: number): number => {
  const v = Number(p[key]);
  return Number.isFinite(v) ? v : fallback;
};

/** A labelled number box on one line. */
function Figure({ label, help, ...box }: { label: string; help?: string } & Omit<Parameters<typeof NumberBox>[0], 'label' | 'id'>) {
  const id = useId();
  return (
    <div className="field inline">
      <label htmlFor={id}>
        {label}
        {help && <Hint text={help} />}
      </label>
      <NumberBox id={id} label={label} {...box} />
    </div>
  );
}

export function MatePanel() {
  const mating = useEditor((s) => s.mating);
  const source = useEditor((s) => s.doc.scene.find((n) => n.id === s.mating?.source) ?? null);
  const busy = useEditor((s) => s.busy !== null);
  const kinds = source?.type === 'part' ? mateKinds(source.part) : [];
  const teeth1 = source?.type === 'part' ? sourceTeeth(source) : 20;
  const worm = source?.type === 'part' && source.part === 'worm';
  const [kind, setKind] = useState<MateKind>(kinds[0] ?? 'gear');
  // Tooth counts follow the gear until they are typed over.
  const [typed, setTyped] = useState<Partial<Record<MateKind, number>>>({});
  const [backlash, setBacklash] = useState(() => (source?.type === 'part' ? num(source.params, 'backlash', 0.1) : 0.1));
  const [extra, setExtra] = useState(0.1);
  const [angle, setAngle] = useState(0);
  const current = kinds.includes(kind) ? kind : kinds[0];
  const fixed = source?.type === 'part' ? fixedMateTeeth(source) : null;
  const teeth = fixed ?? typed[current] ?? (current === 'gear' ? 2 * teeth1 : current === 'ring' ? 3 * teeth1 : current === 'wheel' ? 30 : 12);
  const request: MateRequest = { kind: current, teeth, backlash, extra, angle };
  const mate = source?.type === 'part' ? mateOf(source, request) : null;

  // Every change shows straight away, including edits to the gear itself; the key keeps it to real changes.
  const key = source?.type === 'part' ? JSON.stringify([request, source.params, source.pos, source.rot, source.size]) : null;
  useEffect(() => {
    if (key) void previewMate(JSON.parse(key)[0] as MateRequest);
  }, [key]);
  // The gear is gone (deleted, or the design changed): nothing to mate with.
  useEffect(() => {
    if (mating && source?.type !== 'part') cancelMate();
  }, [mating, source]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelMate();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  if (!mate || !source) return null;

  const setCount = (v: number) => setTyped({ ...typed, [current]: v });
  const finish = (keep: boolean) => (keep ? commitMate() : cancelMate());
  return (
    <div className="mate-panel" role="dialog" aria-label="Mating gear">
      <div className="array-title">Mating gear for {source.name}</div>
      {kinds.length > 1 && (
        <div className="segmented" role="radiogroup" aria-label="Kind of mate">
          {kinds.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={k === current} className={k === current ? 'on' : ''} onClick={() => setKind(k)}>
              {MATE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}
      <div className="mate-pair">
        <Figure label="Teeth" help={fixed !== null ? 'Taken from the bevel gear’s mating tooth count.' : undefined} value={teeth} min={current === 'rack' ? 2 : 5} max={400} integer disabled={fixed !== null} onChange={setCount} />
        {current !== 'rack' && (
          <Figure
            label="Ratio"
            help={worm ? 'Sets the ratio of wheel teeth to worm starts.' : "Sets the ratio of mate teeth to this gear's teeth."}
            value={Number(formatNumber(mate.ratio, 3))}
            min={0.05}
            max={100}
            step={0.1}
            places={3}
            disabled={fixed !== null}
            onChange={(v) => setCount(Math.min(400, Math.max(5, Math.round(v * teeth1))))}
          />
        )}
      </div>
      <Figure label="Backlash" help="How much thinner than ideal the mate's teeth are made. Printed gears usually want 0.1–0.3 mm." value={backlash} unit="mm" min={0} max={2} step={0.05} onChange={setBacklash} />
      <Figure
        label={current === 'bevel' ? 'Extra mounting distance' : 'Extra center distance'}
        help={
          current === 'ring'
            ? 'Pulls the pinion this much further from the ring’s teeth.'
            : current === 'bevel'
              ? 'Moves the mate this much further out along its own axis.'
              : 'Pushes the mate this much further away than the ideal center distance.'
        }
        value={extra}
        unit="mm"
        min={0}
        max={5}
        step={0.05}
        onChange={setExtra}
      />
      <Figure label="Side" help="Where the mate goes, as an angle around this gear: 0° is +X, 90° is +Y." value={angle} unit="°" min={-360} max={360} onChange={setAngle} />
      {mate.note && <p className="field-note">{mate.note}</p>}
      {mate.warnings.map((w) => (
        <p key={w} className="field-note warn">
          {w}
        </p>
      ))}
      <p className="field-note mate-figure">
        {current === 'rack' ? 'Pitch line' : current === 'bevel' ? 'Cone distance' : 'Center distance'} {formatNumber(mate.center, 3)} mm
      </p>
      <div className="mate-actions">
        <button type="button" className="chip" onClick={() => finish(false)}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => finish(true)}>
          Accept
        </button>
      </div>
    </div>
  );
}
