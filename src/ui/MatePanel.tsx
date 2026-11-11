// The mating gear wizard: while it is open the mate stands next to its gear in
// the scene, rebuilt as the figures change, and Accept keeps it. A pulley or a
// sprocket has the same wizard for the other wheel of its belt or chain. It is driven
// by the store's `mating` state, so it stays up while the view is orbited;
// Escape or Cancel drops the preview.
import { useEffect, useId, useState } from 'react';
import { tr } from '../i18n';
import { fixedMateTeeth, MATE_KIND_LABELS, mateKinds, mateOf, sourceTeeth, usualPlanets, usualSpan } from '../parts/mates';
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
  // The mate the panel asks for is not in the scene yet: Accept would keep the one before it.
  const busy = useEditor((s) => s.busy !== null || Boolean(s.mating?.building));
  const kinds = source?.type === 'part' ? mateKinds(source.part) : [];
  const teeth1 = source?.type === 'part' ? sourceTeeth(source) : 20;
  const worm = source?.type === 'part' && source.part === 'worm';
  const [kind, setKind] = useState<MateKind>(kinds[0] ?? 'gear');
  // Tooth counts follow the gear until they are typed over.
  const [typed, setTyped] = useState<Partial<Record<MateKind, number>>>({});
  // The belt's teeth or the chain's links follow the pair until they are typed over.
  const [typedSpan, setTypedSpan] = useState<number | null>(null);
  // The number of planets follows the sun's teeth until it is typed over.
  const [typedPlanets, setTypedPlanets] = useState<number | null>(null);
  const [backlash, setBacklash] = useState(() => (source?.type === 'part' ? num(source.params, 'backlash', 0.1) : 0.1));
  const [extra, setExtra] = useState(0.1);
  const [angle, setAngle] = useState(0);
  const current = kinds.includes(kind) ? kind : kinds[0];
  const fixed = source?.type === 'part' ? fixedMateTeeth(source) : null;
  // A belt or chain joins two wheels at a distance: no teeth mesh, so there is no backlash to set.
  const drive = current === 'pulley' || current === 'sprocket';
  // A ring gear's set: the teeth are the sun's, which the ring already carries a figure for.
  const planetary = current === 'planetary';
  const teeth =
    fixed ?? typed[current] ?? (current === 'gear' ? 2 * teeth1 : current === 'ring' ? 3 * teeth1 : current === 'wheel' || current === 'throated' ? 30 : drive ? teeth1 : planetary && source?.type === 'part' ? Math.round(num(source.params, 'sunTeeth', 12)) : 12);
  const planets = planetary && source?.type === 'part' ? (typedPlanets ?? usualPlanets(source, teeth)) : 3;
  const span = drive && source?.type === 'part' ? (typedSpan ?? usualSpan(source, current, teeth)) : undefined;
  const request: MateRequest = { kind: current, teeth, backlash, extra, angle, ...(span === undefined ? {} : { span }), ...(planetary ? { planets } : {}) };
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
  const finish = (keep: boolean) => (keep ? void commitMate() : cancelMate());
  return (
    <div className="mate-panel" role="dialog" aria-label={current === 'pulley' ? tr('Mating pulley') : current === 'sprocket' ? tr('Mating sprocket') : planetary ? tr('Planetary set') : tr('Mating gear')}>
      <div className="array-title">
        {current === 'pulley'
          ? tr('Mating pulley for {name}', { name: source.name })
          : current === 'sprocket'
            ? tr('Mating sprocket for {name}', { name: source.name })
            : planetary
              ? tr('Planetary set for {name}', { name: source.name })
              : tr('Mating gear for {name}', { name: source.name })}
      </div>
      {kinds.length > 1 && (
        <div className="segmented" role="radiogroup" aria-label={tr('Kind of mate')}>
          {kinds.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={k === current} className={k === current ? 'on' : ''} onClick={() => setKind(k)}>
              {MATE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}
      <div className="mate-pair">
        <Figure label={planetary ? tr('Sun teeth') : tr('Teeth')} help={fixed !== null ? tr('Taken from the bevel gear’s mating tooth count.') : undefined} value={teeth} min={current === 'rack' ? 2 : current === 'pulley' ? 10 : current === 'sprocket' ? 8 : 5} max={current === 'pulley' ? 200 : current === 'sprocket' ? 120 : 400} integer disabled={fixed !== null} onChange={setCount} />
        {planetary && <Figure label={tr('Planets')} value={planets} min={1} max={12} integer onChange={setTypedPlanets} />}
        {current !== 'rack' && !planetary && (
          <Figure
            label={tr('Ratio')}
            help={worm ? tr('Sets the ratio of wheel teeth to worm starts.') : drive ? tr("Sets the ratio of mate teeth to this part's teeth.") : tr("Sets the ratio of mate teeth to this gear's teeth.")}
            value={Number(formatNumber(mate.ratio, 3))}
            min={0.05}
            max={100}
            step={0.1}
            places={3}
            disabled={fixed !== null}
            onChange={(v) => setCount(Math.min(current === 'pulley' ? 200 : current === 'sprocket' ? 120 : 400, Math.max(current === 'pulley' ? 10 : current === 'sprocket' ? 8 : 5, Math.round(v * teeth1))))}
          />
        )}
      </div>
      {drive && (
        <Figure
          label={current === 'pulley' ? tr('Belt teeth') : tr('Chain links')}
          help={current === 'pulley' ? tr('Sets the length of the belt, and with it how far apart the pulleys stand.') : tr('Sets the length of the chain, and with it how far apart the sprockets stand.')}
          value={span ?? 0}
          min={4}
          max={5000}
          integer
          onChange={setTypedSpan}
        />
      )}
      {!drive && <Figure label={tr('Backlash')} help={tr("Sets how much thinner than ideal the mate's teeth are made.")} value={backlash} unit="mm" min={0} max={2} step={0.05} onChange={setBacklash} />}
      {!drive && !planetary && <Figure
        label={current === 'bevel' ? tr('Extra mounting distance') : tr('Extra center distance')}
        help={
          current === 'ring'
            ? tr('Pulls the pinion this much further from the ring’s teeth.')
            : current === 'bevel'
              ? tr('Moves the mate this much further out along its own axis.')
              : tr('Pushes the mate this much further away than the ideal center distance.')
        }
        value={extra}
        unit="mm"
        min={0}
        max={5}
        step={0.05}
        onChange={setExtra}
      />}
      <Figure label={tr('Side')} help={planetary ? tr('Sets the angle around the ring where the first planet goes. 0° is +X, 90° is +Y.') : drive ? tr('Sets the angle around this part where the mate goes. 0° is +X, 90° is +Y.') : tr('Sets the angle around this gear where the mate goes. 0° is +X, 90° is +Y.')} value={angle} unit="°" min={-360} max={360} onChange={setAngle} />
      {mate.note && <p className="field-note">{mate.note}</p>}
      {mate.warnings.map((w) => (
        <p key={w} className="field-note warn">
          {w}
        </p>
      ))}
      <p className="field-note mate-figure">
        {current === 'rack'
          ? tr('Pitch line {distance} mm', { distance: formatNumber(mate.center, 3) })
          : current === 'bevel'
            ? tr('Cone distance {distance} mm', { distance: formatNumber(mate.center, 3) })
            : tr('Center distance {distance} mm', { distance: formatNumber(mate.center, 3) })}
      </p>
      <div className="mate-actions">
        <button type="button" className="chip" onClick={() => finish(false)}>
          {tr('Cancel')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => finish(true)}>
          {tr('Accept')}
        </button>
      </div>
    </div>
  );
}
