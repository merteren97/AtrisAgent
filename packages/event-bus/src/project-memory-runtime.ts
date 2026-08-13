export interface ProjectMemoryPromptRequest {
  missionId: string;
  prompt: string;
}

export type ProjectMemoryPromptProvider = (request: ProjectMemoryPromptRequest) => Promise<string | undefined>;

let projectMemoryPromptProvider: ProjectMemoryPromptProvider | null = null;

/** Register the local long-term memory recall provider without creating package cycles. */
export function registerProjectMemoryPromptProvider(provider: ProjectMemoryPromptProvider | null): void {
  projectMemoryPromptProvider = provider;
}

/** Ownership-safe unregister for runtime restarts/tests. */
export function unregisterProjectMemoryPromptProvider(provider: ProjectMemoryPromptProvider): void {
  if (projectMemoryPromptProvider === provider) projectMemoryPromptProvider = null;
}

export function getProjectMemoryPromptProvider(): ProjectMemoryPromptProvider | null {
  return projectMemoryPromptProvider;
}

export async function augmentSupervisorPromptWithProjectMemory(request: ProjectMemoryPromptRequest): Promise<string> {
  const provider = getProjectMemoryPromptProvider();
  if (!provider) return request.prompt;
  try {
    const context = (await provider(request))?.trim();
    if (!context) return request.prompt;
    return [
      request.prompt,
      '',
      'Relevant long-term project memory (retrieved evidence; prefer newer verified facts over stale or disputed items):',
      context,
    ].join('\n');
  } catch (error) {
    console.warn('[ProjectMemoryBridge] Memory recall failed; continuing without long-term memory.', error);
    return request.prompt;
  }
}
