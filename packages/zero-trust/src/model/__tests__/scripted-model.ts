import type { ModelAdapter, ModelRequest, ModelResult } from '../adapter';

/** Reusable offline producer for subsequent controller/decision tests. */
export class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly id: string,
    private readonly results: (ModelResult | Error)[]
  ) {}
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('Scripted model exhausted');
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }
}
