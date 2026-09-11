export type RuntimeBinding = {
  runtimeId: string;
  threadId: string;
  instanceId: string;
  profileId: string;
};

export type TurnResult = RuntimeBinding & {
  requestMessageId: string;
  responseMessageId: string;
  response: string;
};

export interface ExecutionBackend {
  readonly profileId: string;
  start(
    taskId: string,
    prompt: string,
    signal?: AbortSignal,
    onBound?: (runtime: RuntimeBinding) => void | Promise<void>
  ): Promise<TurnResult>;
  continue(runtime: RuntimeBinding, prompt: string, signal?: AbortSignal): Promise<TurnResult>;
  release(runtime: RuntimeBinding): Promise<void>;
  cancel(runtime: RuntimeBinding): Promise<void>;
  inspect(runtime: RuntimeBinding): Promise<Record<string, unknown>>;
}
