// The rows of a menu that drops from a Popover.

interface MenuItemProps {
  label: string;
  /** The shortcut, shown beside the label. */
  keys?: string;
  /** Marked as something that cannot be taken back. */
  danger?: boolean;
  run: () => void;
  close: () => void;
}

/** One row of a menu: it closes the menu, then does its thing. */
export function MenuItem({ label, keys, danger, run, close }: MenuItemProps) {
  return (
    <button
      type="button"
      className={danger ? 'menu-item danger' : 'menu-item'}
      onClick={() => {
        close();
        run();
      }}
    >
      <span>{label}</span>
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
}
