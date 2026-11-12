// The list a file format is picked from, in the export panel at the bottom of the sidebar.
import { ChevronIcon } from './icons';
import { Popover } from './Popover';

interface Format<Id extends string> {
  id: Id;
  label: string;
  description: string;
}

interface FormatPickerProps<Id extends string> {
  formats: readonly Format<Id>[];
  value: Id;
  onPick: (id: Id) => void;
  /** The button's tooltip. */
  title: string;
  /** What a screen reader calls the list; the tooltip when left out. */
  label?: string;
  /** The formats that cannot be had just now, each with why: shown in the list, and not to be picked. */
  unavailable?: Partial<Record<Id, string>>;
}

/** A button showing the format in use; its list opens upwards: the panel sits at the bottom of the window, where a native select's list would run off the screen. */
export function FormatPicker<Id extends string>({ formats, value, onPick, title, label = title, unavailable = {} }: FormatPickerProps<Id>) {
  const active = formats.find((f) => f.id === value)!;
  return (
    <Popover
      className="select-button"
      title={title}
      align="left"
      side="up"
      fill
      button={
        <>
          <span>{active.label}</span>
          <ChevronIcon />
        </>
      }
    >
      {(close) => (
        <div className="menu" role="listbox" aria-label={label}>
          {formats.map((f) => (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={f.id === value}
              disabled={unavailable[f.id] !== undefined}
              className={f.id === value ? 'menu-item format on' : 'menu-item format'}
              onClick={() => {
                close();
                onPick(f.id);
              }}
            >
              <span>{f.label}</span>
              <small>{unavailable[f.id] ?? f.description}</small>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
