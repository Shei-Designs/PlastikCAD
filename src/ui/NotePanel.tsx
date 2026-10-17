// Words attached to an object: typed here, kept as they go (a sitting of
// typing is one undo step), shown again wherever the object turns up.
import { useEffect, useState } from 'react';
import { MAX_NOTE } from '../model/file';
import { setNote } from '../state/store';

export function NotePanel({ path, note }: { path: string[]; note: string }) {
  const [text, setText] = useState(note);
  // Undo (or another editor of the same note) changes the note under the box; the box's own typing comes back trimmed.
  useEffect(() => {
    if (note !== text.trim()) setText(note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);
  return (
    <div className="note-panel">
      <textarea
        className="text-input area"
        aria-label="Note"
        placeholder="Add a note."
        maxLength={MAX_NOTE}
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNote(path, e.target.value);
        }}
      />
    </div>
  );
}
