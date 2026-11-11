// The way out of a box of choices is its last action: whoever asks must put there the one that
// changes nothing, since Escape, a press beside the box and a question that takes the box's place
// all answer with it.
import { describe, expect, it } from 'vitest';
import { answer, askName, tell } from './ask';

describe('a box of choices', () => {
  it('answers with the action pressed', async () => {
    const chosen = tell({ title: 'Exported', text: 'x.stl is in Downloads.', actions: ['Share', 'Done'] });
    answer('Share');
    expect(await chosen).toBe('Share');
  });

  it('answers with the last action when it is left without one', async () => {
    const chosen = tell({ title: 'Project added', text: 'The file can stay where it is, or go.', actions: ['Delete the file', 'Keep the file'] });
    answer(null);
    expect(await chosen).toBe('Keep the file');
  });

  it('answers with the last action when another question takes its place', async () => {
    const first = tell({ title: 'Project added', text: 'The file can stay where it is, or go.', actions: ['Delete the file', 'Keep the file'] });
    const second = askName({ title: 'Export', label: 'File name', value: 'part', okLabel: 'Export' });
    expect(await first).toBe('Keep the file');
    answer(null);
    expect(await second).toBeNull();
  });
});
