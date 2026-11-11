// The file the geometry worker starts from: requests that arrive before the worker's code has loaded
// wait, and are handed over in the order they came.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest } from './protocol';

const received: WorkerRequest[] = [];
/** The worker's code takes as long to load as the test says. */
const code = vi.hoisted(() => {
  let loaded = (): void => undefined;
  const loading = new Promise<void>((resolve) => (loaded = resolve));
  return { loading, loaded: () => loaded() };
});
vi.mock('./geometry.main', async () => {
  await code.loading;
  return { receive: (request: WorkerRequest) => received.push(request) };
});

const request = (keep: string): WorkerRequest => ({ type: 'forgetAssets', keep: [keep] });

describe('the file the geometry worker starts from', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('holds the requests that come before the code has loaded, then hands each over as it comes', async () => {
    const scope: { onmessage: ((e: { data: WorkerRequest }) => void) | null } = { onmessage: null };
    vi.stubGlobal('self', scope);
    const started = import('./geometry.worker');
    // The start file has run as far as it can without the code: it is already listening.
    await vi.waitFor(() => expect(scope.onmessage).not.toBeNull());
    scope.onmessage!({ data: request('first') });
    scope.onmessage!({ data: request('second') });
    expect(received).toEqual([]);
    code.loaded();
    await started;
    await vi.waitFor(() => expect(received).toHaveLength(2));
    scope.onmessage!({ data: request('third') });
    expect(received).toEqual([request('first'), request('second'), request('third')]);
  });
});
